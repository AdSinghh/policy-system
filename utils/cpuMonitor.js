const pidusage = require("pidusage");
const logger = require("./logger");

/**
 * Samples a process's CPU and trips once usage stays above the threshold.
 *
 * The sampler only detects and reports; the primary owns what a trip *means*
 * (drain, restart, cool down). Keeping those apart is what makes the cooldown
 * and the import suppression expressible at all — the old version killed the
 * worker from inside the sampler, so a still-busy box would be killed again
 * one second after its replacement booted.
 *
 * `pidusage` reports percentage of a single core, so on a multi-core host the
 * value can exceed 100. A 70% threshold therefore means "70% of one core".
 */
function createCpuMonitor({
  thresholdPercent,
  sampleIntervalMs,
  sustainedSamples,
  onTrip,
  isSuppressed = () => false,
}) {
  let timer = null;
  let pid = null;
  let consecutiveHigh = 0;
  let pausedUntil = 0;
  let latest = { cpu: 0, memory: 0, sampledAt: null };

  async function sample() {
    if (!pid) return;

    let stats;
    try {
      stats = await pidusage(pid);
    } catch (err) {
      // Expected while a worker is being replaced: the pid is briefly gone.
      if (err.code !== "ENOENT" && err.code !== "ESRCH") {
        logger.debug("cpuMonitor sample failed: %s", err.message);
      }
      return;
    }

    latest = { cpu: stats.cpu, memory: stats.memory, sampledAt: new Date().toISOString() };

    if (stats.cpu <= thresholdPercent) {
      consecutiveHigh = 0;
      return;
    }

    consecutiveHigh += 1;
    if (consecutiveHigh < sustainedSamples) return;

    // Sustained high CPU confirmed. Decide whether acting on it is appropriate.
    if (Date.now() < pausedUntil) {
      logger.debug("CPU high but monitor is in cooldown; ignoring");
      return;
    }

    if (isSuppressed()) {
      logger.warn(
        "CPU at %d%% for %ds, but an import is running — restart suppressed",
        Math.round(stats.cpu),
        Math.round((sustainedSamples * sampleIntervalMs) / 1000),
      );
      consecutiveHigh = 0;
      return;
    }

    logger.warn(
      "CPU at %d%% (threshold %d%%) for %d consecutive samples — restarting worker",
      Math.round(stats.cpu),
      thresholdPercent,
      sustainedSamples,
    );

    consecutiveHigh = 0;
    onTrip({ cpu: stats.cpu, memory: stats.memory });
  }

  return {
    /** Point the sampler at a (new) pid and reset the streak. */
    watch(nextPid) {
      pid = nextPid;
      consecutiveHigh = 0;
      if (!timer) {
        timer = setInterval(() => {
          sample().catch((err) => logger.debug("cpuMonitor: %s", err.message));
        }, sampleIntervalMs);
        timer.unref();
      }
    },

    /** Ignore trips for a while — used after a restart so it cannot loop. */
    cooldown(durationMs) {
      pausedUntil = Date.now() + durationMs;
      consecutiveHigh = 0;
    },

    getLatest() {
      return { ...latest, thresholdPercent, inCooldown: Date.now() < pausedUntil };
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      pid = null;
    },
  };
}

module.exports = { createCpuMonitor };
