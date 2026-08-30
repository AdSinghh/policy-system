const request = require("supertest");
const app = require("../app");

/**
 * These exercise the validation paths only, which return before touching Mongo —
 * so the suite runs without a database. app.js no longer connects to Mongo or
 * spawns the scheduler at require() time, which is what makes that possible.
 */
describe("request validation", () => {
  describe("POST /api/upload", () => {
    test("no file -> 400", async () => {
      const res = await request(app).post("/api/upload");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no file/i);
    });

    test("wrong file type -> 400", async () => {
      const res = await request(app)
        .post("/api/upload")
        .attach("file", Buffer.from("not a spreadsheet"), "notes.txt");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/unsupported file type/i);
    });
  });

  describe("GET /api/policies/search", () => {
    test("missing username -> 400", async () => {
      const res = await request(app).get("/api/policies/search");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/username/i);
    });

    // The regex-escaping regression is covered in normalize.test.js — asserting
    // it here would need a live database, since the handler reaches Mongo before
    // it can return.
  });

  describe("POST /api/schedules", () => {
    test("empty body -> 400 listing what is missing", async () => {
      const res = await request(app).post("/api/schedules").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/message.*day.*time/i);
    });

    test.each([
      ["unparseable day", { message: "hi", day: "Someday", time: "14:30" }],
      ["out-of-range time", { message: "hi", day: "2026-09-05", time: "25:99" }],
      ["impossible date", { message: "hi", day: "2026-02-31", time: "14:30" }],
      ["unknown timezone", { message: "hi", day: "2026-09-05", time: "14:30", timezone: "Mars/Olympus" }],
      ["blank message", { message: "   ", day: "2026-09-05", time: "14:30" }],
    ])("%s -> 400, not 500", async (_label, body) => {
      const res = await request(app).post("/api/schedules").send(body);
      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe("string");
    });
  });

  describe("GET /api/imports/:id", () => {
    test("malformed id -> 400 rather than a cast error", async () => {
      const res = await request(app).get("/api/imports/not-an-object-id");
      expect(res.status).toBe(400);
    });
  });

  test("unknown route -> 404 JSON", async () => {
    const res = await request(app).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no route/i);
  });
});
