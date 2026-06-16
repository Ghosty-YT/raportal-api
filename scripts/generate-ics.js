const fs = require("fs");
const path = require("path");

process.env.TZ = "Pacific/Auckland";

const INPUT_FILE = "duty-shifts-updated-event-team.min.json";
const OUTPUT_DIR = "calendars";

const CALENDAR_BASE_URL =
  process.env.BASE_CALENDAR_URL ||
  "https://raw.githubusercontent.com/Ghosty-YT/raportal-api/main/calendars";

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
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

function icsDateTime(date, time) {
  if (!date || !time) return "";

  const cleanTime = String(time).trim().slice(0, 5);
  const localDate = new Date(`${date}T${cleanTime}:00`);

  if (isNaN(localDate.getTime())) return "";

  return localDate
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function getStartEnd(person) {
  let start = person.start_time || "";
  let end = person.end_time || "";

  if ((!start || !end) && person.time) {
    const parts = String(person.time).split(/\s*[–—-]\s*/);
    if (parts.length === 2) {
      start = start || parts[0].trim();
      end = end || parts[1].trim();
    }
  }

  return { start, end };
}

function addEvent(calendarMap, raName, event) {
  if (!raName) return;

  const key = normalizeName(raName);

  if (!calendarMap[key]) {
    calendarMap[key] = {
      displayName: raName,
      events: []
    };
  }

  calendarMap[key].events.push(event);
}

function buildUid(type, date, raName, label) {
  return `${type}-${date}-${slugName(raName)}-${slugName(label)}@uht-ra-portal`;
}

function makeDescription(lines) {
  return lines
    .filter(line => line !== undefined && line !== null && String(line).trim() !== "")
    .join("\\n");
}

function makeIcs(displayName, events) {
  const now = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//UHT RA Portal//Duty Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcs(`UHT RA Calendar — ${displayName}`)}`,
    "X-WR-TIMEZONE:Pacific/Auckland"
  ];

  events
    .sort((a, b) => String(a.dtstart).localeCompare(String(b.dtstart)))
    .forEach(event => {
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${escapeIcs(event.uid)}`);
      lines.push(`DTSTAMP:${now}`);
      lines.push(`DTSTART:${event.dtstart}`);
      lines.push(`DTEND:${event.dtend}`);
      lines.push(`SUMMARY:${escapeIcs(event.summary)}`);
      lines.push(`LOCATION:${escapeIcs(event.location || "University Hall Towers")}`);
      lines.push(`DESCRIPTION:${escapeIcs(event.description)}`);
      lines.push("END:VEVENT");
    });

  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}

function main() {
  const data = JSON.parse(fs.readFileSync(INPUT_FILE, "utf8"));

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const calendarMap = {};

  // Duty shifts
  (data.shifts || []).forEach(shift => {
    (shift.people || []).forEach(person => {
      const { start, end } = getStartEnd(person);
      const dtstart = icsDateTime(shift.date, start);
      const dtend = icsDateTime(shift.date, end);

      if (!dtstart || !dtend) return;

      const role = person.role || "Duty";
      const summary = `UHT Duty — ${role}`;

      addEvent(calendarMap, person.name, {
        uid: buildUid("duty", shift.date, person.name, role),
        dtstart,
        dtend,
        summary,
        location: "University Hall Towers",
        description: makeDescription([
          `Type: Duty`,
          `Role: ${role}`,
          `Date: ${shift.day || ""} ${shift.date}`,
          `Time: ${person.time || `${start} – ${end}`}`,
          `Hours: ${person.hours || ""}`,
          `Paycycle: ${shift.pay_cycle || ""}`,
          `Semester: ${shift.semester || ""}`,
          shift.events ? `Event on duty date: ${shift.events}` : "",
          shift.notes ? `Notes: ${shift.notes}` : ""
        ])
      });
    });
  });

  // Event shifts
  (data.event_team || []).forEach(record => {
    (record.people || []).forEach(person => {
      const { start, end } = getStartEnd(person);
      const dtstart = icsDateTime(record.date, start);
      const dtend = icsDateTime(record.date, end);

      if (!dtstart || !dtend) return;

      const eventName = record.event_name || "Event";
      const role = person.role || "Event Team";

      addEvent(calendarMap, person.name, {
        uid: buildUid("event", record.date, person.name, eventName),
        dtstart,
        dtend,
        summary: `UHT Event — ${eventName}`,
        location: "University Hall Towers",
        description: makeDescription([
          `Type: Event`,
          `Event: ${eventName}`,
          `Role: ${role}`,
          `Date: ${record.day || ""} ${record.date}`,
          `Time: ${person.time || `${start} – ${end}`}`,
          `Hours: ${person.hours || ""}`,
          `Paycycle: ${record.pay_cycle || ""}`,
          `Semester: ${record.semester || ""}`
        ])
      });
    });
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
