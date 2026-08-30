const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
};

const cpuCount = require("os").cpus().length;

module.exports = {
  env: process.env.NODE_ENV || "development",
  port: num(process.env.PORT, 4000),
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/policydb",
  logLevel: process.env.LOG_LEVEL || "info",

  // Mongo connection pools are sized per-process. The API process, the scheduler
  // thread and every import worker each open their own, so keep them small —
  // Atlas M0 caps the cluster at 500 connections.
  mongoPoolSize: num(process.env.MONGO_POOL_SIZE, 10),
  mongoWorkerPoolSize: num(process.env.MONGO_WORKER_POOL_SIZE, 5),

  cluster: {
    // One worker keeps the CPU-restart demo legible. Raise it for real
    // deployments: restarts then stop being full outages.
    workers: num(process.env.CLUSTER_WORKERS, 1),
  },

  cpu: {
    thresholdPercent: num(process.env.CPU_THRESHOLD_PERCENT, 70),
    sampleIntervalMs: num(process.env.CPU_SAMPLE_INTERVAL_MS, 1000),
    sustainedSamples: num(process.env.CPU_SUSTAINED_SAMPLES, 5),
    // After a restart, stay quiet long enough for the replacement to boot and
    // connect to Mongo. Without this a genuinely busy box restart-loops.
    cooldownMs: num(process.env.CPU_COOLDOWN_MS, 30000),
    // How long a draining worker gets to finish in-flight requests before SIGKILL.
    drainTimeoutMs: num(process.env.CPU_DRAIN_TIMEOUT_MS, 15000),
    // An import legitimately pins the CPU. Restarting mid-file corrupts the run,
    // so suppress by default and let the import finish.
    restartDuringImport: bool(process.env.CPU_RESTART_DURING_IMPORT, false),
  },

  import: {
    workerCount: num(
      process.env.IMPORT_WORKERS,
      Math.max(1, Math.min(cpuCount - 1, 4)),
    ),
    batchSize: num(process.env.IMPORT_BATCH_SIZE, 200),
    uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads"),
    maxFileSizeMb: num(process.env.IMPORT_MAX_FILE_MB, 25),
    maxRecordedErrors: num(process.env.IMPORT_MAX_ERRORS, 50),
    // Remove the uploaded temp file once the job reaches a terminal state.
    cleanupUploads: bool(process.env.IMPORT_CLEANUP_UPLOADS, true),
  },

  scheduler: {
    enabled: bool(process.env.SCHEDULER_ENABLED, true),
    pollIntervalMs: num(process.env.SCHEDULER_POLL_INTERVAL_MS, 15000),
    // A message claimed but not completed within this window is assumed to
    // belong to a process that died (e.g. a CPU restart) and is reclaimed.
    claimTimeoutMs: num(process.env.SCHEDULER_CLAIM_TIMEOUT_MS, 120000),
    maxAttempts: num(process.env.SCHEDULER_MAX_ATTEMPTS, 3),
    batchSize: num(process.env.SCHEDULER_BATCH_SIZE, 50),
  },

  // Wall-clock times submitted without an explicit timezone are resolved in this
  // zone. UTC by default so behaviour does not depend on where the container runs.
  defaultTimezone: process.env.DEFAULT_TIMEZONE || "UTC",

  // Exposes POST /api/system/load, which burns CPU on purpose so the 70%
  // restart can be demonstrated. Disable in anything resembling production.
  enableLoadEndpoint: bool(process.env.ENABLE_LOAD_ENDPOINT, true),
};
