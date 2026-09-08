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
//It is central configuration file. Its job is to read values from .env,
// convert them into the correct data types, apply defaults, and expose one config object that
//  the rest of the application uses.
const cpuCount = require("os").cpus().length;

module.exports = {
  env: process.env.NODE_ENV || "development",
  port: num(process.env.PORT, 4000),
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/policydb",
  logLevel: process.env.LOG_LEVEL || "info",

  mongoPoolSize: num(process.env.MONGO_POOL_SIZE, 10),
  mongoWorkerPoolSize: num(process.env.MONGO_WORKER_POOL_SIZE, 5),

  cluster: {
    workers: num(process.env.CLUSTER_WORKERS, 1),
  },

  cpu: {
    thresholdPercent: num(process.env.CPU_THRESHOLD_PERCENT, 70),
    sampleIntervalMs: num(process.env.CPU_SAMPLE_INTERVAL_MS, 1000),
    sustainedSamples: num(process.env.CPU_SUSTAINED_SAMPLES, 5),

    cooldownMs: num(process.env.CPU_COOLDOWN_MS, 30000),

    drainTimeoutMs: num(process.env.CPU_DRAIN_TIMEOUT_MS, 15000),

    restartDuringImport: bool(process.env.CPU_RESTART_DURING_IMPORT, false),

    startupFailureMs: num(process.env.STARTUP_FAILURE_MS, 30000),
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

    cleanupUploads: bool(process.env.IMPORT_CLEANUP_UPLOADS, true),
  },

  scheduler: {
    enabled: bool(process.env.SCHEDULER_ENABLED, true),
    pollIntervalMs: num(process.env.SCHEDULER_POLL_INTERVAL_MS, 15000),

    claimTimeoutMs: num(process.env.SCHEDULER_CLAIM_TIMEOUT_MS, 120000),
    maxAttempts: num(process.env.SCHEDULER_MAX_ATTEMPTS, 3),
    batchSize: num(process.env.SCHEDULER_BATCH_SIZE, 50),
  },

  defaultTimezone: process.env.DEFAULT_TIMEZONE || "UTC",

  enableLoadEndpoint: bool(process.env.ENABLE_LOAD_ENDPOINT, true),
};
