const {
  resolveScheduledInstant,
  wallClockToUtc,
  isValidTimezone,
  InvalidScheduleInput,
} = require("../utils/datetime");

describe("resolveScheduledInstant", () => {
  /**
   * The original handler did `new Date("2026-09-05T14:30:00")`, which parses in
   * the server's local zone. On a machine in Asia/Calcutta that is 09:00Z; in a
   * UTC container it is 14:30Z — a 5.5-hour drift for an identical request.
   */
  test("resolves a wall-clock time in the requested zone, not the server's", () => {
    const utc = resolveScheduledInstant({
      day: "2026-09-05",
      time: "14:30",
      timeZone: "UTC",
    });
    const kolkata = resolveScheduledInstant({
      day: "2026-09-05",
      time: "14:30",
      timeZone: "Asia/Kolkata",
    });

    expect(utc.runAt.toISOString()).toBe("2026-09-05T14:30:00.000Z");
    expect(kolkata.runAt.toISOString()).toBe("2026-09-05T09:00:00.000Z");
  });

  test("the result does not depend on the machine's TZ", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      const a = resolveScheduledInstant({ day: "2026-09-05", time: "14:30", timeZone: "UTC" });
      process.env.TZ = "Asia/Kolkata";
      const b = resolveScheduledInstant({ day: "2026-09-05", time: "14:30", timeZone: "UTC" });

      expect(a.runAt.toISOString()).toBe(b.runAt.toISOString());
    } finally {
      process.env.TZ = original;
    }
  });

  test("handles a zone that observes DST on both sides of the change", () => {
    const summer = resolveScheduledInstant({
      day: "2026-07-01",
      time: "12:00",
      timeZone: "America/New_York",
    });
    const winter = resolveScheduledInstant({
      day: "2026-12-01",
      time: "12:00",
      timeZone: "America/New_York",
    });

    expect(summer.runAt.toISOString()).toBe("2026-07-01T16:00:00.000Z"); // EDT, UTC-4
    expect(winter.runAt.toISOString()).toBe("2026-12-01T17:00:00.000Z"); // EST, UTC-5
  });

  test("accepts seconds", () => {
    const { runAt } = resolveScheduledInstant({
      day: "2026-09-05",
      time: "14:30:45",
      timeZone: "UTC",
    });
    expect(runAt.toISOString()).toBe("2026-09-05T14:30:45.000Z");
  });

  describe("weekday input", () => {
    // The brief says "day" without defining it, so weekday names are supported.
    const now = new Date("2026-09-02T10:00:00.000Z"); // a Wednesday

    test("resolves to the next occurrence of that weekday", () => {
      const { runAt, kind } = resolveScheduledInstant({
        day: "Monday",
        time: "09:00",
        timeZone: "UTC",
        now,
      });
      expect(kind).toBe("weekday");
      expect(runAt.toISOString()).toBe("2026-09-07T09:00:00.000Z");
    });

    test("later today counts as today", () => {
      const { runAt } = resolveScheduledInstant({
        day: "Wednesday",
        time: "18:00",
        timeZone: "UTC",
        now,
      });
      expect(runAt.toISOString()).toBe("2026-09-02T18:00:00.000Z");
    });

    test("already past today rolls to next week", () => {
      const { runAt } = resolveScheduledInstant({
        day: "Wednesday",
        time: "08:00",
        timeZone: "UTC",
        now,
      });
      expect(runAt.toISOString()).toBe("2026-09-09T08:00:00.000Z");
    });

    test("abbreviations and casing are accepted", () => {
      const { runAt } = resolveScheduledInstant({ day: "fri", time: "09:00", timeZone: "UTC", now });
      expect(runAt.toISOString()).toBe("2026-09-04T09:00:00.000Z");
    });
  });

  describe("rejects bad input with a typed error", () => {
    // Each of these previously produced an Invalid Date, failed Mongoose
    // validation inside the try block, and surfaced to the client as a 500.
    const cases = [
      ["a weekday-shaped string that is not a weekday", { day: "Someday", time: "14:30" }],
      ["a malformed time", { day: "2026-09-05", time: "25:99" }],
      ["a non-numeric time", { day: "2026-09-05", time: "afternoon" }],
      ["a date that does not exist", { day: "2026-02-31", time: "14:30" }],
      ["a missing day", { day: "", time: "14:30" }],
      ["an unknown timezone", { day: "2026-09-05", time: "14:30", timeZone: "Mars/Olympus" }],
    ];

    test.each(cases)("%s", (_label, input) => {
      expect(() => resolveScheduledInstant({ timeZone: "UTC", ...input })).toThrow(
        InvalidScheduleInput,
      );
    });
  });
});

describe("wallClockToUtc", () => {
  test("round-trips through a positive offset", () => {
    const result = wallClockToUtc(
      { year: 2026, month: 1, day: 15, hour: 5, minute: 30 },
      "Asia/Kolkata",
    );
    expect(result.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });
});

describe("isValidTimezone", () => {
  test.each([
    ["UTC", true],
    ["Asia/Kolkata", true],
    ["America/New_York", true],
    ["Not/AZone", false],
    ["", false],
  ])("%s -> %s", (zone, expected) => {
    expect(isValidTimezone(zone)).toBe(expected);
  });
});
