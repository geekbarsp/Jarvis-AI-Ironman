function parseClock(hourValue, minuteValue, meridiem) {
  let hour = Number(hourValue);
  const minute = Number(minuteValue || 0);
  if (!Number.isInteger(hour) || hour < 1 || hour > 12 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (String(meridiem).toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (String(meridiem).toLowerCase() === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((item) => item.type !== "literal").map((item) => [item.type, Number(item.value)]));
}

export function zonedDateTime(year, month, day, hour, minute, timezone) {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = zonedParts(new Date(candidate), timezone);
    const represented = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
    const correction = desired - represented;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate);
}

function localDateKey(date, timezone) {
  const value = zonedParts(date, timezone);
  return `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

function chooseScheduleDate(reminders, topic, now, timezone) {
  const today = localDateKey(now, timezone);
  const candidates = (reminders || [])
    .filter((item) => !item.done && String(item.text || "").toLowerCase().includes(topic))
    .map((item) => ({ item, date: new Date(item.at) }))
    .filter(({ date }) => Number.isFinite(date.getTime()))
    .sort((left, right) => Math.abs(left.date - now) - Math.abs(right.date - now));
  const todayMatch = candidates.find(({ date }) => localDateKey(date, timezone) === today);
  return zonedParts(todayMatch?.date || candidates[0]?.date || now, timezone);
}

export function resolveReminderScheduleCorrection(query, { reminders = [], now = new Date(), timezone = "UTC" } = {}) {
  const text = String(query || "").replace(/[–—]/g, "-").trim();
  if (!/\b(?:edit|change|correct|fix|update|replace)\b/i.test(text) || !/\breminders?\b/i.test(text)) return null;
  const range = text.match(/\b(?:work|shift)\b[^.]{0,40}?\bfrom\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+(?:to|until|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
    || text.match(/\bfrom\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+(?:to|until|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!range || !/\b(?:work|shift)\b/i.test(text)) return null;
  const start = parseClock(range[1], range[2], range[3]);
  const end = parseClock(range[4], range[5], range[6]);
  if (!start || !end || (start.hour === end.hour && start.minute === end.minute)) return null;
  const date = chooseScheduleDate(reminders, "work", now, timezone);
  const startAt = zonedDateTime(date.year, date.month, date.day, start.hour, start.minute, timezone);
  let endAt = zonedDateTime(date.year, date.month, date.day, end.hour, end.minute, timezone);
  if (endAt <= startAt) {
    const nextDay = zonedParts(new Date(startAt.getTime() + 26 * 60 * 60 * 1000), timezone);
    endAt = zonedDateTime(nextDay.year, nextDay.month, nextDay.day, end.hour, end.minute, timezone);
  }
  return {
    operation: "reconcileSchedule",
    topic: "work",
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    startText: "Start work",
    endText: "End work",
  };
}

export function formatScheduleTime(iso, timezone) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone }).format(new Date(iso));
}

export function resolveStaleReminderReference(query, { reminders = [], timezone = "UTC" } = {}) {
  const text = String(query || "").trim();
  if (!/\breminders?\b/i.test(text) || !/\bstill\b/i.test(text)) return null;
  const clock = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  const label = /\bwake\s*up\b/i.test(text) ? "wake up" : "";
  if (!clock || !label) return null;
  const requested = parseClock(clock[1], clock[2], clock[3]);
  if (!requested) return null;
  const atRequestedTime = (reminders || []).filter((item) => {
    if (item.done) return false;
    const at = new Date(item.at);
    if (!Number.isFinite(at.getTime())) return false;
    const parts = zonedParts(at, timezone);
    return parts.hour === requested.hour && parts.minute === requested.minute;
  });
  return {
    label,
    displayLabel: "WAKE UP",
    displayTime: `${clock[1]}${clock[2] ? `:${clock[2]}` : ":00"} ${clock[3].toUpperCase()}`,
    matches: atRequestedTime.filter((item) => /\bwake\s*up\b/i.test(item.text)),
    otherAtTime: atRequestedTime.filter((item) => !/\bwake\s*up\b/i.test(item.text)),
  };
}

function reminderWords(value) {
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9]+/g) || []);
}

export function resolveReminderRemoval(query, { reminders = [] } = {}) {
  const text = String(query || "").trim();
  if (!/\b(?:remove|delete|cancel|clear)\b/i.test(text)) return null;
  if (/\b(?:all|every)\b[^.]{0,25}\breminders?\b|\b(?:remove|delete|clear)\s+(?:all\s+)?my\s+reminders?\b/i.test(text)) {
    return { operation: "cancelAll", matches: reminders.filter((item) => !item.done), label: "all reminders" };
  }
  const targetMatch = text.match(/\b(?:remove|delete|cancel)\s+(?:my|the)?\s*(.+?)(?:\s+reminders?)?[.!?]*$/i);
  if (!targetMatch) return null;
  const target = targetMatch[1]
    .replace(/\breminders?\b/gi, " ")
    .replace(/\b(?:at|for)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!target) return null;
  const targetWords = reminderWords(target);
  const matches = reminders.filter((item) => {
    if (item.done) return false;
    const words = reminderWords(item.text);
    return [...targetWords].every((word) => words.has(word));
  });
  return { operation: "cancelMany", ids: matches.map((item) => item.id), matches, label: target };
}
