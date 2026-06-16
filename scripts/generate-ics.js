const fs = require("fs");
const path = require("path");

process.env.TZ = "Pacific/Auckland";

const INPUT_FILE = "duty-shifts-updated-event-team.min.json";
const OUTPUT_DIR = "calendars";

const CALENDAR_BASE_URL =
  process.env.BASE_CALENDAR_URL ||
  "https://raw.githubusercontent.com/Ghosty-YT/raportal-api/main/calendars";

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ");
}

function normalizeName(value) {
  return normalizeText(value);
}

function slugName(value) {
  return normalizeName(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeIcs(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function foldLine(line) {
  const chunks = [];
  let text = line;

  while (text.length > 75) {
    chunks.push(text.slice(0, 75));
    text = " " + text.slice(75);
  }

  chunks.push(text);
  return chunks.join("\r\n");
}

function compactUtcDateTime(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function icsDateTime(date, time) {
  if (!date || !time) return "";

  const cleanTime = String(time).trim().slice(0, 5);
  const localDate = new Date(`${date}T${cleanTime}:00`);

  if (isNaN(localDate.getTime())) return "";

  return compactUtcDateTime(localDate);
}

function icsAllDayDate(date) {
  return String(date || "").replace(/-/g, "");
}

function addDaysIso(date, days) {
  const [year, month, day] = String(date || "")
    .split("-")
    .map(Number);

  if (!year || !month || !day) return date;

  const utcDate = new Date(Date.UTC(year, month - 1, day + days));
  return utcDate.toISOString().slice(0, 10);
}

function getStartEnd(personOrEntry) {
  let start = personOrEntry.start_time || "";
  let end = personOrEntry.end_time || "";

  if ((!start || !end) && personOrEntry.time) {
    const parts = String(personOrEntry.time).split(/\s*[–—-]\s*/);
    if (parts.length === 2) {
      start = start || parts[0].trim();
      end = end || parts[1].trim();
    }
  }

  return { start, end };
}

function isAbsenceTask(task) {
  const text = normalizeText(task);

  return (
    text.includes("lwop") ||
    text.includes("leave without pay") ||
    text === "sick" ||
    text.startsWith("sick ") ||
    text.includes("sick leave")
  );
}

function isTotalTask(task) {
  const text = normalizeText(task);

  return (
    text === "total" ||
    text.endsWith(" total") ||
    text.includes("total hours")
  );
}

function isDutyTask(task) {
  return normalizeText(task) === "duty";
}

function isAllowedOtherWorkTask(task) {
  const text = normalizeText(task);

  return (
    text.includes("ra meeting") ||
    text.includes("ra training")
  );
}

function applyDefaultTimesForOtherWork(entry) {
  const task = normalizeText(entry.task || entry.original_task || "");

  if (task.includes("ra training")) {
    return {
      ...entry,
      time: "08:30 – 16:30",
      start_time: "08:30",
      end_time: "16:30"
    };
  }

  if (task.includes("ra meeting")) {
    return {
      ...entry,
      time: "19:00 – 20:00",
      start_time: "19:00",
      end_time: "20:00"
    };
  }

  return entry;
}

function isExcludedCalendarPerson(person) {
  if (!person) return true;

  const fields = [
    person.role,
    person.task,
    person.status,
    person.note,
    person.notes,
    person.event_name,
    person.original_event_name
  ];

  return fields.some(value => {
    const text = normalizeText(value);
    return isAbsenceTask(text) || isTotalTask(text);
  });
}

function isExcludedCalendarEventName(value) {
  const text = normalizeText(value);
  return isAbsenceTask(text) || isTotalTask(text);
}

function shouldExcludeOtherWorkTask(task) {
  const text = normalizeText(task);

  if (!text) return true;
  if (isAbsenceTask(text)) return true;
  if (isTotalTask(text)) return true;
  if (isDutyTask(text)) return true;

  // These should NOT go into ICS.
  if (text.includes("manager")) return true;
  if (text === "admin" || text.includes("admin")) return true;
  if (text.includes("roll call")) return true;
  if (text.includes("floor meeting")) return true;
  if (text.includes("uta floor meeting")) return true;
  if (text.includes("flat chat")) return true;
  if (text.includes("1:1")) return true;
  if (text.includes("one on one")) return true;

  // Only RA Meeting and RA Training are allowed as extra work.
  return !isAllowedOtherWorkTask(text);
}

function addEvent(calendarMap, raName, event) {
  if (!raName) return;

  const key = normalizeName(raName);

  if (!calendarMap[key]) {
    calendarMap[key] = {
      displayName: raName,
      events: [],
      seen: new Set()
    };
  }

  if (calendarMap[key].seen.has(event.dedupeKey)) {
    return;
  }

  calendarMap[key].seen.add(event.dedupeKey);
  calendarMap[key].events.push(event);
}

function buildUid(type, date, raName, label, extra = "") {
  return `${type}-${date}-${slugName(raName)}-${slugName(label)}-${slugName(extra)}@uht-ra-portal`;
}

function makeDescription(lines) {
  return lines
    .filter(line => line !== undefined && line !== null && String(line).trim() !== "")
    .join("\\n");
}

function timedEventLines(event) {
  return [
    `DTSTART:${event.dtstart}`,
    `DTEND:${event.dtend}`
  ];
}

function allDayEventLines(event) {
  return [
    `DTSTART;VALUE=DATE:${event.dtstartDate}`,
    `DTEND;VALUE=DATE:${event.dtendDate}`
  ];
}

function makeIcs(displayName, events) {
  const now = compactUtcDateTime(new Date());

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//UHT RA Portal//Duty Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcs(`UHT RA Calendar — ${displayName}`)}`,
    "X-WR-TIMEZONE:Pacific/Auckland",

  // Best-effort refresh hints for subscribed calendar apps.
  // Source roster updates twice daily, so two-hour checks are enough.
  // Calendar apps may still ignore these and use their own refresh schedule.
    "REFRESH-INTERVAL;VALUE=DURATION:PT2H",
    "X-PUBLISHED-TTL:PT2H"
  ];

  events
    .sort((a, b) => {
      const aSort = a.dtstart || a.dtstartDate || "";
      const bSort = b.dtstart || b.dtstartDate || "";
      return String(aSort).localeCompare(String(bSort));
    })
    .forEach(event => {
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${escapeIcs(event.uid)}`);
      lines.push(`DTSTAMP:${now}`);

      const dateLines = event.isAllDay ? allDayEventLines(event) : timedEventLines(event);
      dateLines.forEach(line => lines.push(line));

      lines.push(`SUMMARY:${escapeIcs(event.summary)}`);
      lines.push(`LOCATION:${escapeIcs(event.location || "University Hall Towers")}`);
      lines.push(`DESCRIPTION:${escapeIcs(event.description)}`);
      lines.push("END:VEVENT");
    });

  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}

function createTimedOrAllDayEvent({
  type,
  date,
  raName,
  label,
  summary,
  location,
  description,
  personOrEntry,
  dedupeExtra
}) {
  const { start, end } = getStartEnd(personOrEntry);
  const dtstart = icsDateTime(date, start);
  const dtend = icsDateTime(date, end);

  const dedupeKey = [
    type,
    date,
    normalizeName(raName),
    normalizeText(label),
    normalizeText(start),
    normalizeText(end),
    String(personOrEntry.hours || ""),
    normalizeText(dedupeExtra || "")
  ].join("|");

  if (dtstart && dtend) {
    return {
      isAllDay: false,
      uid: buildUid(type, date, raName, label, dedupeExtra),
      dedupeKey,
      dtstart,
      dtend,
      summary,
      location,
      description
    };
  }

  // RA Meeting / RA Training often only have date + hours, no start/end time.
  // In that case, make an all-day calendar reminder.
  return {
    isAllDay: true,
    uid: buildUid(type, date, raName, label, dedupeExtra),
    dedupeKey,
    dtstartDate: icsAllDayDate(date),
    dtendDate: icsAllDayDate(addDaysIso(date, 1)),
    summary,
    location,
    description
  };
}

function main() {
  const data = JSON.parse(fs.readFileSync(INPUT_FILE, "utf8"));

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const calendarMap = {};

  // 1. Duty shifts
  (data.shifts || []).forEach(shift => {
    (shift.people || []).forEach(person => {
      const role = person.role || "Duty";
      const label = `Duty ${role}`;

      const event = createTimedOrAllDayEvent({
        type: "duty",
        date: shift.date,
        raName: person.name,
        label,
        summary: `UHT Duty — ${role}`,
        location: "University Hall Towers",
        personOrEntry: person,
        dedupeExtra: role,
        description: makeDescription([
          `Type: Duty`,
          `Role: ${role}`,
          `Date: ${shift.day || ""} ${shift.date}`,
          person.time ? `Time: ${person.time}` : "",
          person.hours ? `Hours: ${person.hours}` : "",
          shift.pay_cycle ? `Paycycle: ${shift.pay_cycle}` : "",
          shift.semester ? `Semester: ${shift.semester}` : "",
          shift.events ? `Event on duty date: ${shift.events}` : "",
          shift.notes ? `Notes: ${shift.notes}` : ""
        ])
      });

      addEvent(calendarMap, person.name, event);
    });
  });

// 2. Event team shifts
(data.event_team || []).forEach(record => {
  const eventName = record.event_name || "Event";

  // Do not generate calendar events for Sick/LWOP/Total rows that were parsed as events.
  if (isExcludedCalendarEventName(eventName)) return;

  (record.people || [])
    .filter(person => !isExcludedCalendarPerson(person))
    .forEach(person => {
      const role = person.role || "Event Team";

      const event = createTimedOrAllDayEvent({
        type: "event",
        date: record.date,
        raName: person.name,
        label: eventName,
        summary: `UHT Event — ${eventName}`,
        location: "University Hall Towers",
        personOrEntry: person,
        dedupeExtra: eventName,
        description: makeDescription([
          `Type: Event`,
          `Event: ${eventName}`,
          `Role: ${role}`,
          `Date: ${record.day || ""} ${record.date}`,
          person.time ? `Time: ${person.time}` : "",
          person.hours ? `Hours: ${person.hours}` : "",
          record.pay_cycle ? `Paycycle: ${record.pay_cycle}` : "",
          record.semester ? `Semester: ${record.semester}` : ""
        ])
      });

      addEvent(calendarMap, person.name, event);
    });
});

  // 3. Allowed other work from paycycle_entries
  // Only RA Meeting and RA Training are included.
  (data.paycycle_entries || []).forEach(entry => {
    const task = entry.task || entry.original_task || "";

    if (shouldExcludeOtherWorkTask(task)) return;

    const timedEntry = applyDefaultTimesForOtherWork(entry);

    const event = createTimedOrAllDayEvent({
      type: "work",
      date: timedEntry.date,
      raName: timedEntry.name,
      label: task,
      summary: `UHT Work — ${task}`,
      location: "University Hall Towers",
      personOrEntry: timedEntry,
      dedupeExtra: task,
      description: makeDescription([
        `Type: Other Work`,
        `Task: ${task}`,
        `Date: ${timedEntry.day || ""} ${timedEntry.date}`,
        timedEntry.time ? `Time: ${timedEntry.time}` : "",
        timedEntry.hours ? `Hours: ${timedEntry.hours}` : "",
        timedEntry.pay_cycle ? `Paycycle: ${timedEntry.pay_cycle}` : "",
        timedEntry.semester ? `Semester: ${timedEntry.semester}` : "",
        timedEntry.source_sheet ? `Source: ${timedEntry.source_sheet}` : ""
      ])
    });

    addEvent(calendarMap, timedEntry.name, event);
  });

  const index = [];

  Object.keys(calendarMap)
    .sort()
    .forEach(key => {
      const calendar = calendarMap[key];
      const fileName = `${slugName(calendar.displayName)}.ics`;
      const filePath = path.join(OUTPUT_DIR, fileName);

      fs.writeFileSync(filePath, makeIcs(calendar.displayName, calendar.events));

      index.push({
        name: calendar.displayName,
        normalized_name: key,
        file: fileName,
        url: `${CALENDAR_BASE_URL}/${fileName}`,
        event_count: calendar.events.length
      });
    });

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "index.json"),
    JSON.stringify(index, null, 2)
  );

  console.log(`Generated ${index.length} RA calendars.`);
}

main();
