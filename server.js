const cluster = require("cluster");
const path = require("path");

const config = require("./config");
const logger = require("./utils/logger");

// The punycode deprecation comes from a transitive dependency and cannot be
// fixed here; everything else should still surface.
process.on("warning", (warning) => {
  if (warning.code === "DEP0040" || /punycode/i.test(warning.message)) return;
  logger.warn("%s: %s", warning.name, warning.message);
});

// `cluster.isMaster` is deprecated in favour of `isPrimary` (Node 16+).
if (cluster.isPrimary) {
  runPrimary();
} else {
  // runWorker is async: without this catch, a failed initial database connection
  // becomes an unhandled rejection that prints a topology dump and kills the
  // worker, and the primary re-forks into a crash loop.
  runWorker().catch((err) => {
    logger.error("API worker failed to start: %s", err.message);
    process.exit(1);
  });
}

/* ────────────────────────────── primary ────────────────────────────────── */

/**
 * Supervises the API workers and owns the CPU restart policy (Task 2.1).
 *
 * The primary stays deliberately idle: it holds no database connection and
 * serves no traffic, so its own CPU never confuses the measurement and it stays
 * responsive enough to replace a worker that is pinned at 100%.
 */
function runPrimary() {
  const { createCpuMonitor } = require("./utils/cpuMonitor");

  const workers = new Map(); // pid -> { worker, importActive, draining, startedAt }
  let shuttingDown = false;

  /**
   * Crash-loop protection: a worker that dies sooner than this was almost
   * certainly a startup failure rather than a recycled one.
   *
   * This must sit comfortably above the driver's server-selection timeout. An
   * unreachable database takes serverSelectionTimeoutMS (10s) plus DNS and TLS
   * setup to fail — measured at 13-15s against Atlas. With the threshold set to
   * 10s every such death looked "slow enough to be healthy", the counter reset
   * each time, and the supervisor re-forked forever without ever backing off.
   */
  const FAST_EXIT_MS = config.cpu.startupFailureMs;
  const MAX_FAST_EXITS = 5;
  let consecutiveFastExits = 0;

  const monitor = createCpuMonitor({
    thresholdPercent: config.cpu.thresholdPercent,
    sampleIntervalMs: config.cpu.sampleIntervalMs,
    sustainedSamples: config.cpu.sustainedSamples,
    // Sample every live worker that is not already on its way out.
    getPids: () =>
      [...workers.entries()]
        .filter(([, entry]) => !entry.draining)
        .map(([pid]) => pid),
    isSuppressed: () =>
      !config.cpu.restartDuringImport &&
      [...workers.values()].some((entry) => entry.importActive),
    onTrip: (pid) => {
      const target = workers.get(pid);
      if (target) recycle(target, "cpu threshold exceeded");
    },
  });

  function spawn() {
    const worker = cluster.fork();
    const entry = {
      worker,
      importActive: false,
      draining: false,
      startedAt: Date.now(),
    };
    workers.set(worker.process.pid, entry);

    // Workers report when an import starts/stops so the watchdog can stand down
    // rather than killing the import it is measuring.
    worker.on("message", (message) => {
      if (message?.type === "import:active") {
        entry.importActive = Boolean(message.active);
      }
    });

    logger.info("Forked API worker pid=%d", worker.process.pid);
    return entry;
  }

  /**
   * Replace a worker without dropping in-flight work.
   *
   * Ask it to drain, hold a SIGKILL in reserve for one that will not stop, and
   * only fork the replacement once it is actually gone — otherwise two workers
   * briefly share the port and the monitor watches the wrong pid.
   */
  function recycle(entry, reason) {
    if (entry.draining || shuttingDown) return;
    entry.draining = true;

    const { worker } = entry;
    logger.warn(
      "Recycling worker pid=%d (%s); draining up to %dms",
      worker.process.pid,
      reason,
      config.cpu.drainTimeoutMs,
    );

    try {
      worker.send({ type: "shutdown" });
    } catch {
      // Channel already closed; the SIGKILL timer will finish the job.
    }

    // Stop sampling this pid immediately; it is already on its way out.
    monitor.forget(worker.process.pid);

    const force = setTimeout(() => {
      logger.warn("Worker pid=%d did not drain in time; sending SIGKILL", worker.process.pid);
      try {
        worker.process.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, config.cpu.drainTimeoutMs);
    force.unref();

    worker.once("exit", () => clearTimeout(force));

    // Do not evaluate CPU again until the replacement has booted and connected.
    monitor.cooldown(config.cpu.cooldownMs + config.cpu.drainTimeoutMs);
  }

  cluster.on("exit", (worker, code, signal) => {
    const entry = workers.get(worker.process.pid);
    const lifetimeMs = entry ? Date.now() - entry.startedAt : Infinity;
    const wasDeliberate = Boolean(entry?.draining);
    workers.delete(worker.process.pid);

    logger.info(
      "Worker pid=%d exited (code=%s signal=%s) after %dms",
      worker.process.pid,
      code,
      signal || "none",
      lifetimeMs,
    );

    if (shuttingDown) return;

    /**
     * Distinguish "recycled on purpose" from "died on startup".
     *
     * A worker that cannot reach the database exits immediately, and re-forking
     * it at full speed burns a core producing identical stack traces. Back off
     * exponentially, then give up so the container exits and the orchestrator
     * (Docker restart policy, systemd, ECS) can surface a real failure.
     */
    if (!wasDeliberate && lifetimeMs < FAST_EXIT_MS) {
      consecutiveFastExits += 1;
    } else {
      consecutiveFastExits = 0;
    }

    if (consecutiveFastExits >= MAX_FAST_EXITS) {
      logger.error(
        "Worker exited within %dms on %d consecutive attempts — giving up. " +
          "Check MONGO_URI and that this host is allowed to reach the database.",
        FAST_EXIT_MS,
        consecutiveFastExits,
      );
      process.exit(1);
    }

    const delayMs = consecutiveFastExits
      ? Math.min(30000, 1000 * 2 ** (consecutiveFastExits - 1))
      : 0;

    if (delayMs) {
      logger.warn(
        "Restarting worker in %dms (attempt %d/%d)",
        delayMs,
        consecutiveFastExits,
        MAX_FAST_EXITS,
      );
    }

    // Deliberately not unref'd: while no worker is alive this timer is the only
    // thing holding the primary's event loop open. Unref'ing it makes the
    // supervisor exit 0 during backoff, which looks like a clean shutdown.
    setTimeout(() => {
      if (shuttingDown) return;
      spawn();
      monitor.cooldown(config.cpu.cooldownMs);
    }, delayMs);
  });

  for (let i = 0; i < config.cluster.workers; i += 1) spawn();
  monitor.start();

  logger.info(
    "Primary pid=%d supervising %d worker(s); restart at %d%% CPU sustained over %d samples",
    process.pid,
    config.cluster.workers,
    config.cpu.thresholdPercent,
    config.cpu.sustainedSamples,
  );

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info("%s received; shutting down cluster", signal);
      monitor.stop();

      for (const { worker } of workers.values()) {
        try {
          worker.send({ type: "shutdown" });
        } catch {
          /* ignore */
        }
      }

      setTimeout(() => process.exit(0), config.cpu.drainTimeoutMs).unref();
    });
  }
}

/* ────────────────────────────── worker ─────────────────────────────────── */

/** Serves the API, and runs the scheduler thread alongside it. */
async function runWorker() {
  const { connect, disconnect } = require("./db/connect");
  const app = require("./app");

  await connect();

  const server = app.listen(config.port, () => {
    logger.info("API worker pid=%d listening on %d", process.pid, config.port);
  });

  const scheduler = startScheduler();

  let closing = false;

  /**
   * Stop accepting connections, let in-flight requests finish, then exit.
   *
   * The old watchdog called worker.process.kill() directly, which dropped
   * everything mid-flight — including a running import.
   */
  async function drain(reason) {
    if (closing) return;
    closing = true;
    logger.info("Worker pid=%d draining (%s)", process.pid, reason);

    scheduler?.postMessage({ type: "shutdown" });
    server.close(async () => {
      try {
        await disconnect();
      } catch (err) {
        logger.warn("Error closing Mongo connection: %s", err.message);
      }
      process.exit(0);
    });

    // Backstop for a connection that never closes (keep-alive, slow client).
    setTimeout(() => {
      logger.warn("Drain timed out; exiting anyway");
      process.exit(0);
    }, config.cpu.drainTimeoutMs).unref();
  }

  process.on("message", (message) => {
    if (message?.type === "shutdown") drain("supervisor requested shutdown");
  });
  process.on("SIGTERM", () => drain("SIGTERM"));
  process.on("SIGINT", () => drain("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection: %s", reason?.stack || reason);
  });
}

/**
 * The scheduler runs as a worker thread of the API process.
 *
 * It therefore dies and restarts with its worker, which is fine and deliberate:
 * all state is in Mongo, claims are atomic, and an abandoned claim is reclaimed
 * after SCHEDULER_CLAIM_TIMEOUT_MS. Nothing is lost across a CPU restart.
 */
function startScheduler() {
  if (!config.scheduler.enabled) {
    logger.info("Scheduler disabled (SCHEDULER_ENABLED=false)");
    return null;
  }

  const { Worker } = require("worker_threads");

  try {
    const worker = new Worker(
      path.join(__dirname, "workers", "schedulerWorker.js"),
      { workerData: { mongoUri: config.mongoUri } },
    );

    worker.on("error", (err) => logger.error("Scheduler thread error: %s", err.message));
    worker.on("exit", (code) => {
      if (code !== 0) logger.warn("Scheduler thread exited with code %d", code);
    });

    return worker;
  } catch (err) {
    logger.error("Could not start scheduler: %s", err.message);
    return null;
  }
}
