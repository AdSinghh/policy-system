const express = require("express");
const os = require("os");
const mongoose = require("mongoose");
const pidusage = require("pidusage");

const config = require("../config");
const logger = require("../utils/logger");
const { isImportActive } = require("../services/importRunner");

const router = express.Router();

const MONGO_STATES = ["disconnected", "connected", "connecting", "disconnecting"];

/** GET /api/system/status — process health, plus what the watchdog is watching. */
router.get("/status", async (req, res) => {
  let cpu = null;
  let memory = null;

  try {
    const stats = await pidusage(process.pid);
    cpu = Number(stats.cpu.toFixed(2));
    memory = stats.memory;
  } catch (err) {
    logger.debug("pidusage failed: %s", err.message);
  }

  res.json({
    status: "ok",
    pid: process.pid,
    uptimeSeconds: Number(process.uptime().toFixed(1)),
    cpuPercent: cpu,
    memoryBytes: memory,
    loadAverage: os.loadavg(),
    cpuCount: os.cpus().length,
    importActive: isImportActive(),
    watchdog: {
      thresholdPercent: config.cpu.thresholdPercent,
      sustainedSamples: config.cpu.sustainedSamples,
      sampleIntervalMs: config.cpu.sampleIntervalMs,
      suppressedDuringImport: !config.cpu.restartDuringImport,
    },
    mongo: MONGO_STATES[mongoose.connection.readyState] || "unknown",
    timezone: config.defaultTimezone,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/system/load?seconds=8
 *
 * Burns CPU on the event loop on purpose, so the 70% watchdog can be observed
 * doing its job. Without something like this the restart behaviour is only
 * reachable by accident. Gated behind ENABLE_LOAD_ENDPOINT.
 */
router.post("/load", (req, res) => {
  if (!config.enableLoadEndpoint) {
    return res.status(404).json({ error: "Load generator is disabled." });
  }

  const seconds = Math.min(60, Math.max(1, parseInt(req.query.seconds || "8", 10) || 8));

  logger.warn("Load generator: burning CPU for %ds on pid %d", seconds, process.pid);

  // Answer before blocking — once the loop is busy nothing else gets sent.
  res.json({
    burningForSeconds: seconds,
    pid: process.pid,
    expect: `CPU should exceed ${config.cpu.thresholdPercent}% for ${config.cpu.sustainedSamples} samples, then this worker is drained and replaced.`,
  });

  setTimeout(() => {
    const until = Date.now() + seconds * 1000;
    // Deliberately synchronous: this is what starving the event loop looks like.
    while (Date.now() < until) {
      Math.sqrt(Math.random() * Number.MAX_SAFE_INTEGER);
    }
    logger.warn("Load generator finished on pid %d", process.pid);
  }, 50);
});

module.exports = router;
