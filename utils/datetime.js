/**
 * Resolves a wall-clock "day + time" into an absolute UTC instant.
 *
 * `new Date("2026-09-05T14:30:00")` — no zone suffix — is parsed in the *server's*
 * local zone. The same request therefore means different things on a developer's
 * machine (Asia/Calcutta) and in a container (UTC): a 5.5-hour drift. Everything
 * here goes through an explicit IANA zone instead, defaulting to UTC.
 *
 * Uses Intl rather than a date library, so there is no extra dependency and no
 * bundled timezone database to go stale.
 */

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const WEEKDAY_ALIASES = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3,
  thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

class InvalidScheduleInput extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidScheduleInput";
  }
}

function isValidTimezone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Offset, in ms, between the given zone and UTC at a specific instant.
 * Positive east of Greenwich. Accounts for DST because it asks Intl what the
 * local wall clock actually reads at that moment.
 */
function zoneOffsetMs(instantMs, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = {};
  for (const { type, value } of formatter.formatToParts(new Date(instantMs))) {
    parts[type] = value;
  }

  // Some ICU builds render midnight as hour 24.
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );

  return asIfUtc - instantMs;
}

/**
 * Wall-clock fields in `timeZone` -> the UTC instant they denote.
 *
 * Two passes: guess by treating the wall time as UTC and subtracting the offset,
 * then re-check the offset at that candidate instant. The second pass is what
 * gets DST transitions right, where the offset before and after differ.
 */
function wallClockToUtc({ year, month, day, hour, minute, second = 0 }, timeZone) {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  const firstGuess = asIfUtc - zoneOffsetMs(asIfUtc, timeZone);
  const refinedOffset = zoneOffsetMs(firstGuess, timeZone);
  const result = asIfUtc - refinedOffset;

  return new Date(result);
}

/** Calendar fields as they read in `timeZone` at a given instant. */
function zonedParts(instant, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = {};
  for (const { type, value } of formatter.formatToParts(instant)) {
    parts[type] = value;
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAYS.indexOf(String(parts.weekday).toLowerCase()),
  };
}

function parseTime(time) {
  const match = TIME_PATTERN.exec(String(time ?? "").trim());
  if (!match) {
    throw new InvalidScheduleInput(
      `'time' must look like HH:MM or HH:MM:SS (24-hour). Received: ${JSON.stringify(time)}`,
    );
  }

  const [, h, m, s] = match;
  const hour = Number(h);
  const minute = Number(m);
  const second = s === undefined ? 0 : Number(s);

  if (hour > 23 || minute > 59 || second > 59) {
    throw new InvalidScheduleInput(
      `'time' is out of range: ${JSON.stringify(time)}. Hours 00-23, minutes and seconds 00-59.`,
    );
  }

  return { hour, minute, second };
}

function parseWeekday(day) {
  const normalized = String(day ?? "").trim().toLowerCase();
  const exact = WEEKDAYS.indexOf(normalized);
  if (exact !== -1) return exact;
  if (Object.hasOwn(WEEKDAY_ALIASES, normalized)) {
    return WEEKDAY_ALIASES[normalized];
  }
  return -1;
}

/**
 * Resolve `day` + `time` in `timeZone` to a UTC instant.
 *
 * `day` accepts either a calendar date (YYYY-MM-DD) or a weekday name
 * ("Monday", "fri"). The brief says only "day", so both readings are supported;
 * a weekday resolves to its next occurrence at or after `now`.
 *
 * @throws {InvalidScheduleInput} so callers can answer 400 rather than 500.
 */
function resolveScheduledInstant({ day, time, timeZone = "UTC", now = new Date() }) {
  if (!isValidTimezone(timeZone)) {
    throw new InvalidScheduleInput(
      `'timezone' is not a recognised IANA zone: ${JSON.stringify(timeZone)}. Example: Asia/Kolkata`,
    );
  }

  const { hour, minute, second } = parseTime(time);
  const rawDay = String(day ?? "").trim();

  if (!rawDay) {
    throw new InvalidScheduleInput(
      "'day' is required: either a date (YYYY-MM-DD) or a weekday name.",
    );
  }

  const dateMatch = DATE_PATTERN.exec(rawDay);
  if (dateMatch) {
    const [, y, m, d] = dateMatch.map(Number);

    // Reject 2026-02-31 style input, which Date would silently roll over.
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (
      probe.getUTCFullYear() !== y ||
      probe.getUTCMonth() !== m - 1 ||
      probe.getUTCDate() !== d
    ) {
      throw new InvalidScheduleInput(`'day' is not a real calendar date: ${rawDay}`);
    }

    return {
      runAt: wallClockToUtc({ year: y, month: m, day: d, hour, minute, second }, timeZone),
      kind: "date",
      timeZone,
    };
  }

  const weekday = parseWeekday(rawDay);
  if (weekday === -1) {
    throw new InvalidScheduleInput(
      `'day' must be a date (YYYY-MM-DD) or a weekday name. Received: ${JSON.stringify(day)}`,
    );
  }

  // Walk forward from today in the target zone to the next matching weekday.
  const today = zonedParts(now, timeZone);
  let delta = (weekday - today.weekday + 7) % 7;

  let candidate = wallClockToUtc(
    { year: today.year, month: today.month, day: today.day + delta, hour, minute, second },
    timeZone,
  );

  // Same weekday but the time has already passed -> next week.
  if (candidate.getTime() <= now.getTime()) {
    delta += 7;
    candidate = wallClockToUtc(
      { year: today.year, month: today.month, day: today.day + delta, hour, minute, second },
      timeZone,
    );
  }

  return { runAt: candidate, kind: "weekday", timeZone };
}

module.exports = {
  resolveScheduledInstant,
  wallClockToUtc,
  zoneOffsetMs,
  isValidTimezone,
  InvalidScheduleInput,
  WEEKDAYS,
};
