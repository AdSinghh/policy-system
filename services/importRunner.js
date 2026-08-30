const path = require("path");
const fs = require("fs/promises");
const { Worker } = require("worker_threads");

const config = require("../config");
const logger = require("../utils/logger");
const ImportJob = require("../models/ImportJob");

const WORKER_PATH = path.join(__dirname, "..", "workers", "importWorker.js");

// Number of imports currently running in this process. The CPU watchdog lives in
// the cluster primary, so the count is relayed over cluster IPC; without it the
// watchdog sees an import's legitimate CPU spike and kills the worker mid-file.
let activeImports = 0;

function signalPrimary() {
  if (typeof process.send !== "function") return;
  try {
    process.send({ type: "import:active", active: activeImports > 0 });
  } catch (err) {
    logger.warn("Could not signal primary about import state: %s", err.message);
  }
}

function isImportActive() {
  return activeImports > 0;
}

/**
 * Spawns the worker pool for one uploaded file and keeps its ImportJob current.
 *
 * Returns as soon as the pool is running; the caller has already answered the
 * HTTP request with a job id. Progress and the terminal state land on the job
 * document, which the client polls.
 */
async function runImport(job) {
  activeImports += 1;
  signalPrimary();

  const startedAt = new Date();
  const workerCount = Math.max(1, config.import.workerCount);

  await ImportJob.updateOne(
    { _id: job._id },
    { $set: { status: "running", startedAt, workerCount } },
  );

  const totals = { processed: 0, skipped: 0, failed: 0 };
  const errors = [];
  const failures = [];

  const spawn = (workerIndex) =>
    new Promise((resolve) => {
      const worker = new Worker(WORKER_PATH, {
        workerData: {
          filePath: job.storedPath,
          originalName: job.originalName,
          mongoUri: config.mongoUri,
          workerIndex,
          workerCount,
          batchSize: config.import.batchSize,
        },
      });

      // Each worker reports deltas; accumulate rather than overwrite.
      let lastProcessed = 0;
      let lastSkipped = 0;

      worker.on("message", (message) => {
        if (message.type === "progress" || message.type === "done") {
          totals.processed += message.processed - lastProcessed;
          totals.skipped += message.skipped - lastSkipped;
          lastProcessed = message.processed;
          lastSkipped = message.skipped;

          if (message.errors?.length) {
            for (const entry of message.errors) {
              if (errors.length < config.import.maxRecordedErrors) {
                errors.push(entry);
              }
            }
          }
        }

        if (message.type === "failed") {
          failures.push(`worker ${workerIndex}: ${message.error}`);
        }
      });

      worker.on("error", (err) => {
        logger.error("import worker %d errored: %s", workerIndex, err.message);
        failures.push(`worker ${workerIndex}: ${err.message}`);
      });

      worker.on("exit", (code) => {
        if (code !== 0 && !failures.some((f) => f.startsWith(`worker ${workerIndex}:`))) {
          failures.push(`worker ${workerIndex} exited with code ${code}`);
        }
        resolve();
      });
    });

  // Persist progress periodically so a long import is observable while it runs.
  const ticker = setInterval(() => {
    ImportJob.updateOne(
      { _id: job._id },
      {
        $set: {
          processedRows: totals.processed,
          skippedRows: totals.skipped,
        },
      },
    ).catch((err) => logger.warn("progress update failed: %s", err.message));
  }, 1000);

  try {
    await Promise.all(
      Array.from({ length: workerCount }, (_, index) => spawn(index)),
    );

    clearInterval(ticker);

    const finishedAt = new Date();
    const counts = await collectCounts();

    await ImportJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: failures.length ? "partial" : "completed",
          processedRows: totals.processed,
          skippedRows: totals.skipped,
          failedRows: failures.length,
          rowErrors: errors,
          counts,
          finishedAt,
          durationMs: finishedAt - startedAt,
          error: failures.length ? failures.join("; ") : undefined,
        },
      },
    );

    logger.info(
      "Import %s finished: processed=%d skipped=%d in %dms",
      job._id,
      totals.processed,
      totals.skipped,
      finishedAt - startedAt,
    );
  } catch (err) {
    clearInterval(ticker);
    logger.error("Import %s failed: %s", job._id, err.message);
    await ImportJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "failed",
          error: err.message,
          finishedAt: new Date(),
          processedRows: totals.processed,
          skippedRows: totals.skipped,
        },
      },
    ).catch(() => {});
  } finally {
    activeImports = Math.max(0, activeImports - 1);
    signalPrimary();
    await cleanup(job.storedPath);
  }
}

/** Post-run collection sizes, for a quick sanity check on the job document. */
async function collectCounts() {
  const [agents, users, accounts, categories, carriers, policies] =
    await Promise.all([
      require("../models/Agent").estimatedDocumentCount(),
      require("../models/User").estimatedDocumentCount(),
      require("../models/Account").estimatedDocumentCount(),
      require("../models/Category").estimatedDocumentCount(),
      require("../models/Carrier").estimatedDocumentCount(),
      require("../models/Policy").estimatedDocumentCount(),
    ]);
  return { agents, users, accounts, categories, carriers, policies };
}

/** Uploads are scratch space; leaving them behind grows the disk forever. */
async function cleanup(storedPath) {
  if (!config.import.cleanupUploads || !storedPath) return;
  try {
    await fs.unlink(storedPath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      logger.warn("Could not remove upload %s: %s", storedPath, err.message);
    }
  }
}

module.exports = { runImport, isImportActive };
