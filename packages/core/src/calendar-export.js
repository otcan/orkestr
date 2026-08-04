function clean(value = "") { return String(value || "").trim(); }

function calendarError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function dateValue(value, field) {
  const parsed = new Date(value || "");
  if (Number.isNaN(parsed.getTime())) throw calendarError(`calendar_${field}_invalid`);
  return parsed;
}

function icsEscape(value = "") {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function calendarTime(value) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function googleDate(value) {
  return calendarTime(value);
}

function stableUid(input = {}) {
  const value = clean(input.uid || input.id);
  if (value) return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 180);
  return `orkestr-${randomUUID()}`;
}

export function createCalendarExport(input = {}, now = new Date()) {
  const title = clean(input.title || input.summary).replace(/[\r\n]+/g, " ").slice(0, 300);
  if (!title) throw calendarError("calendar_title_required");
  const startsAt = dateValue(input.startsAt || input.start || input.startTime, "start");
  const endsAt = dateValue(input.endsAt || input.end || input.endTime, "end");
  if (endsAt <= startsAt) throw calendarError("calendar_end_must_follow_start");
  const description = String(input.description || input.details || "").replace(/\u0000/g, "").slice(0, 8_000);
  const location = clean(input.location).replace(/[\r\n]+/g, " ").slice(0, 500);
  const uid = stableUid(input);
  const event = {
    uid,
    title,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    description,
    location,
    createdAt: now.toISOString(),
  };
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Orkestr//Calendar Export//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsEscape(uid)}`,
    `DTSTAMP:${calendarTime(now)}`,
    `DTSTART:${calendarTime(startsAt)}`,
    `DTEND:${calendarTime(endsAt)}`,
    `SUMMARY:${icsEscape(title)}`,
    ...(description ? [`DESCRIPTION:${icsEscape(description)}`] : []),
    ...(location ? [`LOCATION:${icsEscape(location)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ];
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${googleDate(startsAt)}/${googleDate(endsAt)}`,
  });
  if (description) params.set("details", description);
  if (location) params.set("location", location);
  return {
    event,
    ics: lines.join("\r\n"),
    googleCalendarUrl: `https://calendar.google.com/calendar/render?${params.toString()}`,
  };
}
import { randomUUID } from "node:crypto";
