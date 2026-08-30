const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const config = require("../config");
const logger = require("../utils/logger");
const ScheduledPost = require("../models/ScheduledPost");
const Post = require("../models/Post");
const {
  resolveScheduledInstant,
  InvalidScheduleInput,
} = require("../utils/datetime");

/**
 * POST /api/schedules
 * Body: { message, day, time, timezone? }
 *
 *   day       "2026-09-05" or a weekday name ("Monday", "fri")
 *   time      "14:30" or "14:30:00", 24-hour
 *   timezone  IANA zone, e.g. "Asia/Kolkata". Defaults to DEFAULT_TIMEZONE (UTC).
 *
 * The stored `runAt` is an absolute instant. Previously the handler built
 * `new Date(\`${day}T${time}:00\`)`, which parses in the server's local zone —
 * the same request meant 09:00Z on a developer's machine and 14:30Z in the
 * container. Malformed input also reached Mongoose and surfaced as a 500; input
 * is now validated up front so it answers 400.
 */
router.post("/", async (req, res) => {
  const { message, day, time } = req.body || {};
  const timezone = req.body?.timezone || config.defaultTimezone;

  const missing = ["message", "day", "time"].filter((field) => !req.body?.[field]);
  if (missing.length) {
    return res.status(400).json({
      error: `Missing required field(s): ${missing.join(", ")}.`,
      expected: { message: "string", day: "YYYY-MM-DD or weekday name", time: "HH:MM" },
    });
  }

  if (typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "'message' must be a non-empty string." });
  }

  let resolved;
  try {
    resolved = resolveScheduledInstant({ day, time, timeZone: timezone });
  } catch (err) {
    if (err instanceof InvalidScheduleInput) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  try {
    const doc = await ScheduledPost.create({
      message: message.trim(),
      day: String(day),
      time: String(time),
      timezone: resolved.timeZone,
      dayKind: resolved.kind,
      runAt: resolved.runAt,
      status: "pending",
    });

    logger.info(
      "Scheduled message %s for %s (%s %s %s)",
      doc._id,
      doc.runAt.toISOString(),
      day,
      time,
      resolved.timeZone,
    );

    res.status(201).json({
      id: doc._id,
      message: doc.message,
      day: doc.day,
      time: doc.time,
      timezone: doc.timezone,
      runAt: doc.runAt,
      status: doc.status,
      // A past instant is accepted deliberately — the scheduler delivers it on
      // the next poll — but say so rather than letting it look like a bug.
      note:
        doc.runAt <= new Date()
          ? "runAt is in the past; this will be delivered on the next scheduler poll."
          : undefined,
    });
  } catch (err) {
    logger.error("Failed to schedule message: %s", err.message);
    res.status(500).json({ error: "Could not schedule the message." });
  }
});

/** GET /api/schedules?status= — inspect the queue. */
router.get("/", async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "50", 10)));
  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  try {
    const scheduled = await ScheduledPost.find(filter)
      .sort({ runAt: 1 })
      .limit(limit)
      .lean();
    res.json({ scheduled });
  } catch (err) {
    logger.error("Failed to list schedules: %s", err.message);
    res.status(500).json({ error: "Could not list scheduled messages." });
  }
});

/** GET /api/schedules/delivered — messages the scheduler has written out. */
router.get("/delivered", async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "50", 10)));
  try {
    const posts = await Post.find().sort({ publishedAt: -1 }).limit(limit).lean();
    res.json({ posts });
  } catch (err) {
    logger.error("Failed to list delivered posts: %s", err.message);
    res.status(500).json({ error: "Could not list delivered messages." });
  }
});

/** DELETE /api/schedules/:id — cancel something still pending. */
router.delete("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: "Not a valid schedule id." });
  }

  try {
    const doc = await ScheduledPost.findOneAndUpdate(
      { _id: req.params.id, status: "pending" },
      { $set: { status: "cancelled" } },
      { new: true },
    );

    if (!doc) {
      return res
        .status(404)
        .json({ error: "No pending scheduled message with that id." });
    }
    res.json({ id: doc._id, status: doc.status });
  } catch (err) {
    logger.error("Failed to cancel schedule: %s", err.message);
    res.status(500).json({ error: "Could not cancel the scheduled message." });
  }
});

module.exports = router;
