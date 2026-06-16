const fs = require("fs");

const SEM1_FILE = "sem1-source.json";
const SEM2_FILE = "sem2-source.json";
const OUTPUT_FILE = "duty-shifts-updated-event-team.min.json";

const SEM1_END = "2026-07-04";
const SEM2_START = "2026-07-05";

function readJson(path) {
  const text = fs.readFileSync(path, "utf8");
  return JSON.parse(text);
}

function dateInSem1(date) {
  return date && date <= SEM1_END;
}

function dateInSem2(date) {
  return date && date >= SEM2_START;
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeName(value) {
  return normalizeText(value);
}

function cloneWithSemester(record, semester) {
  return {
    ...record,
    semester
  };
}

function collectShifts(payload, semester, predicate) {
  return (payload.shifts || [])
    .filter(shift => predicate(shift.date))
    .map(shift => ({
      ...cloneWithSemester(shift, semester),
      event_team: []
    }));
}

function collectPaycycleEntries(payload, semester, predicate) {
  return (payload.paycycle_entries || [])
    .filter(entry => predicate(entry.date))
    .map(entry => cloneWithSemester(entry, semester));
}

function collectEventTeam(payload, semester, predicate) {
  const records = [];

  (payload.event_team || []).forEach(record => {
    if (predicate(record.date)) {
      records.push(cloneWithSemester(record, semester));
    }
  });

  (payload.shifts || []).forEach(shift => {
    if (!predicate(shift.date)) return;

    (shift.event_team || []).forEach(record => {
      records.push(cloneWithSemester(record, semester));
    });
  });

  return records;
}

function dutyPersonKey(person) {
  return [
    normalizeName(person.name),
    normalizeText(person.role),
    normalizeText(person.time),
    String(person.hours || "")
  ].join("|");
}

function addPersonIfMissing(people, person) {
  if (!person || !person.name) return;

  const key = dutyPersonKey(person);

  if (!people.some(existing => dutyPersonKey(existing) === key)) {
    people.push(person);
  }
}

function eventRecordKey(record) {
  return [
    record.date,
    normalizeText(record.event_name || record.original_event_name),
    normalizeText(record.semester)
  ].join("|");
}

function mergeEventTeam(records) {
  const map = {};

  records.forEach(record => {
    if (!record || !record.date || !record.event_name) return;

    const key = eventRecordKey(record);

    if (!map[key]) {
      map[key] = {
        ...record,
        people: []
      };
    }

    (record.people || []).forEach(person => {
      addPersonIfMissing(map[key].people, person);
    });
  });

  return Object.values(map).sort((a, b) => {
    return (
      String(a.date).localeCompare(String(b.date)) ||
      String(a.event_name).localeCompare(String(b.event_name))
    );
  });
}

function paycycleEntryKey(entry) {
  return [
    entry.date,
    normalizeName(entry.name),
    normalizeText(entry.task),
    normalizeText(entry.time),
    String(entry.hours || ""),
    normalizeText(entry.semester)
  ].join("|");
}

function dedupePaycycleEntries(entries) {
  const seen = new Set();
  const output = [];

  entries.forEach(entry => {
    const key = paycycleEntryKey(entry);

    if (!seen.has(key)) {
      seen.add(key);
      output.push(entry);
    }
  });

  return output.sort((a, b) => {
    return (
      String(a.date).localeCompare(String(b.date)) ||
      String(a.name).localeCompare(String(b.name)) ||
      String(a.task).localeCompare(String(b.task))
    );
  });
}

function shiftKey(shift) {
  return `${shift.date}|${normalizeText(shift.semester)}`;
}

function dedupeShifts(shifts) {
  const map = {};

  shifts.forEach(shift => {
    if (!shift || !shift.date) return;

    const key = shiftKey(shift);

    if (!map[key]) {
      map[key] = {
        ...shift,
        people: shift.people || [],
        event_team: []
      };
    }
  });

  return Object.values(map).sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function ensureShiftEventName(shift, eventName) {
  if (!shift || !eventName) return;

  const key = normalizeText(eventName);

  shift.event_names = Array.isArray(shift.event_names) ? shift.event_names : [];
  shift.event_names_original = Array.isArray(shift.event_names_original)
    ? shift.event_names_original
    : [];

  const exists = shift.event_names_original.some(name => normalizeText(name) === key);

  if (!exists) {
    shift.event_names.push(eventName);
    shift.event_names_original.push(eventName);
  }

  if (!shift.events) {
    shift.events = eventName;
  } else if (!normalizeText(shift.events).includes(key)) {
    shift.events = `${shift.events}, ${eventName}`;
  }
}

function attachEventTeamToShifts(shifts, eventTeam) {
  const shiftByDateSemester = {};

  shifts.forEach(shift => {
    shift.event_team = [];
    shiftByDateSemester[`${shift.date}|${normalizeText(shift.semester)}`] = shift;
  });

  eventTeam.forEach(record => {
    const key = `${record.date}|${normalizeText(record.semester)}`;
    const shift = shiftByDateSemester[key];

    if (!shift) return;

    shift.event_team.push(record);
    ensureShiftEventName(shift, record.event_name);
  });
}

function main() {
  const sem1 = readJson(SEM1_FILE);
  const sem2 = readJson(SEM2_FILE);

  const shifts = dedupeShifts([
    ...collectShifts(sem1, "Semester 1", dateInSem1),
    ...collectShifts(sem2, "Semester 2", dateInSem2)
  ]);

  const paycycle_entries = dedupePaycycleEntries([
    ...collectPaycycleEntries(sem1, "Semester 1", dateInSem1),
    ...collectPaycycleEntries(sem2, "Semester 2", dateInSem2)
  ]);

  const event_team = mergeEventTeam([
    ...collectEventTeam(sem1, "Semester 1", dateInSem1),
    ...collectEventTeam(sem2, "Semester 2", dateInSem2)
  ]);

  attachEventTeamToShifts(shifts, event_team);

  const warnings = [
    ...(sem1.warnings || []).map(w => `[Semester 1] ${w}`),
    ...(sem2.warnings || []).map(w => `[Semester 2] ${w}`)
  ];

  const payload = {
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    source: "UH Semester 1 + Semester 2 Roster 2026",
    meta: {
      shift_count: shifts.length,
      paycycle_entry_count: paycycle_entries.length,
      event_team_count: event_team.length,
      warning_count: warnings.length
    },
    handover: {
      semester_1_until: SEM1_END,
      semester_2_from: SEM2_START
    },
    shifts,
    paycycle_entries,
    event_team,
    warnings: warnings.slice(0, 100)
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload));
  console.log(`Merged roster written to ${OUTPUT_FILE}`);
  console.log(payload.meta);
}

main();
