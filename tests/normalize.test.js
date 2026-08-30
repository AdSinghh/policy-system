const n = require("../utils/normalize");

describe("escapeRegex", () => {
  /**
   * The search handler used to build `new RegExp(username, "i")` straight from
   * the query string: `?username=(` threw a SyntaxError and returned 500, and a
   * crafted pattern could pin the CPU — which would then trip the watchdog and
   * restart the server.
   */
  test.each(["(", ")", "[", "a|b", ".*", "a+b", "^x", "x$", "\\", "a{2,}", "?"])(
    "%s stays a literal and compiles",
    (input) => {
      const pattern = new RegExp(`^${n.escapeRegex(input)}`);
      expect(pattern.test(input)).toBe(true);
    },
  );

  test("a catastrophic-backtracking pattern is neutralised", () => {
    const evil = "(a+)+$";
    const pattern = new RegExp(`^${n.escapeRegex(evil)}`);

    const started = Date.now();
    pattern.test("a".repeat(40));
    expect(Date.now() - started).toBeLessThan(100);
  });

  test("a prefix search still matches what it should", () => {
    const pattern = new RegExp(`^${n.escapeRegex("lura")}`);
    expect(pattern.test("lura lucca")).toBe(true);
    expect(pattern.test("alura lucca")).toBe(false);
  });
});

describe("text", () => {
  test.each([
    ["  Lura   Lucca  ", "Lura Lucca"],
    ["", ""],
    [null, ""],
    [undefined, ""],
    [123, "123"],
  ])("%p -> %p", (input, expected) => {
    expect(n.text(input)).toBe(expected);
  });
});

describe("number", () => {
  test("parses plain and formatted amounts", () => {
    expect(n.number("1180.83")).toBe(1180.83);
    expect(n.number("$1,180.83")).toBe(1180.83);
  });

  // Distinguishing absent from zero is what keeps averages honest.
  test.each(["", "   ", null, undefined, "n/a"])("%p -> null", (input) => {
    expect(n.number(input)).toBeNull();
  });

  test("a real zero survives", () => {
    expect(n.number("0")).toBe(0);
  });
});

describe("date", () => {
  test("ISO dates land at UTC midnight regardless of server zone", () => {
    expect(n.date("1960-02-11").toISOString()).toBe("1960-02-11T00:00:00.000Z");
  });

  test.each(["", "not a date", null])("%p -> null", (input) => {
    expect(n.date(input)).toBeNull();
  });

  test("passes a Date through", () => {
    const input = new Date("2020-01-01T00:00:00.000Z");
    expect(n.date(input).toISOString()).toBe(input.toISOString());
  });
});

describe("phone", () => {
  test.each([
    ["8677356559", "8677356559", null],
    ["(336) 245-8310", "3362458310", null],
    ["(336) 761-8572 Ext.0012", "3367618572", "0012"],
    ["(336) 744-0520 Ext.23225", "3367440520", "23225"],
  ])("%s -> digits %s, ext %s", (input, digits, extension) => {
    const result = n.phone(input);
    expect(result.phoneDigits).toBe(digits);
    expect(result.phoneExtension).toBe(extension);
    expect(result.phone).toBe(input);
  });

  test("blank yields nulls throughout", () => {
    expect(n.phone("")).toEqual({ phone: null, phoneDigits: null, phoneExtension: null });
  });
});

describe("zip", () => {
  test("keeps ZIP+4 intact and derives a 5-digit form", () => {
    expect(n.zip("27101-3843")).toEqual({ zip: "27101-3843", zip5: "27101" });
  });

  // Parsing this as a number would turn it into 1234.
  test("preserves a leading zero", () => {
    expect(n.zip("01234")).toEqual({ zip: "01234", zip5: "01234" });
  });
});

describe("compact", () => {
  test("drops empty values but keeps falsy-but-real ones", () => {
    expect(n.compact({ a: "x", b: "", c: null, d: undefined, e: 0, f: false })).toEqual({
      a: "x",
      e: 0,
      f: false,
    });
  });
});
