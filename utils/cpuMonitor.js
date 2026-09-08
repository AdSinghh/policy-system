const pidusage = require("pidusage");
const logger = require("./logger");

// Monitors CPU usage of API workers.
//"It detects sustained high CPU usage and tells the cluster supervisor when a worker should be recycled."
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
