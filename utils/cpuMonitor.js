const pidusage = require("pidusage");
const logger = require("./logger");

/**
 * Samples the CPU of every API worker and trips on the first one to stay above
 * the threshold.
 *
 * The sampler only detects and reports; the primary owns what a trip *means*
 * (drain, replace, cool down). Keeping those apart is what makes the cooldown
 * and the import suppression expressible at all — the original version killed
 * the worker from inside the sampler, so a still-busy box would be killed again
 * one second after its replacement booted.
 *
 * Streaks are tracked per pid, so one hot worker cannot be masked by an idle
 * sibling and a replacement never inherits its predecessor's streak.
 *
 * `pidusage` reports percentage of a single core, so on a multi-core host the
 * value can exceed 100. A 70% threshold therefore means "70% of one core".
 */
function createCpuMonitor({
  thresholdPercent,
  sampleIntervalMs,
  sustainedSamples,
  getPids,
  onTrip,
  isSuppressed = () => false,
}) {
  let timer = null;
  let pausedUntil = 0;
  const streaks = new Map(); // pid -> consecutive samples above threshold
  const latest = new Map(); // pid -> last reading

  async function sample() {
    const pids = getPids();
    if (pids.length === 0) return;

    // Forget workers that have gone away, so a recycled pid starts clean.
    for (const pid of streaks.keys()) {
      if (!pids.includes(pid)) {
        streaks.delete(pid);
        latest.delete(pid);
      }
    }

    let readings;
    try {
      readings = await pidusage(pids);
    } catch (err) {
      // Expected while a worker is being replaced: the pid is briefly gone.
      if (err.code !== "ENOENT" && err.code !== "ESRCH") {
        logger.debug("cpuMonitor sample failed: %s", err.message);
      }
      return;
    }

    for (const pid of pids) {
      const stats = readings[pid];
      if (!stats) continue;

      latest.set(pid, {
        pid,
        cpu: stats.cpu,
        memory: stats.memory,
        sampledAt: new Date().toISOString(),
      });

      if (stats.cpu <= thresholdPercent) {
        streaks.set(pid, 0);
        continue;
      }

      const streak = (streaks.get(pid) || 0) + 1;
      streaks.set(pid, streak);
      if (streak < sustainedSamples) continue;

      // Sustained high CPU confirmed. Decide whether acting on it is appropriate.
      if (Date.now() < pausedUntil) {
        logger.debug("CPU high on pid %d but monitor is in cooldown", pid);
        continue;
      }

      if (isSuppressed()) {
        logger.warn(
          "CPU at %d%% for %ds on pid %d, but an import is running — restart suppressed",
          Math.round(stats.cpu),
          Math.round((sustainedSamples * sampleIntervalMs) / 1000),
          pid,
        );
        streaks.set(pid, 0);
        continue;
      }

      logger.warn(
        "CPU at %d%% (threshold %d%%) for %d consecutive samples on pid %d — restarting worker",
        Math.round(stats.cpu),
        thresholdPercent,
        sustainedSamples,
        pid,
      );

      streaks.set(pid, 0);
      onTrip(pid, { cpu: stats.cpu, memory: stats.memory });

      // One worker per pass: recycling is serialised so a load spike that hits
      // every worker at once cannot take the whole cluster down together.
      return;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        sample().catch((err) => logger.debug("cpuMonitor: %s", err.message));
      }, sampleIntervalMs);
      timer.unref();
    },

    /** Ignore trips for a while — used after a restart so it cannot loop. */
    cooldown(durationMs) {
      pausedUntil = Date.now() + durationMs;
      streaks.clear();
    },

    /** Drop a pid's streak immediately, e.g. once it has been asked to drain. */
    forget(pid) {
      streaks.delete(pid);
      latest.delete(pid);
    },

    getLatest() {
      return {
        workers: [...latest.values()],
        thresholdPercent,
        inCooldown: Date.now() < pausedUntil,
      };
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createCpuMonitor };
