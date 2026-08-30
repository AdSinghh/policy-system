const { parentPort, workerData, threadId } = require("worker_threads");

const config = require("../config");
const logger = require("../utils/logger");
const { connect, disconnect } = require("../db/connect");
const { readRows } = require("../utils/rowSource");
const { transformRow } = require("../utils/transform");

/**
 * One worker of the import pool.
 *
 * Striping: each worker opens the file itself and handles only the rows where
 * `rowIndex % workerCount === workerIndex`. Parsing is repeated per worker, but
 * parsing is cheap next to the database round trips, and this keeps every worker
 * streaming and memory-bounded with no coordination and no shared cursor.
 *
 * Batching: the previous implementation awaited six queries per row — roughly
 * 7,200 sequential round trips for the 1,198-row sheet. Each batch here is six
 * unordered bulkWrites regardless of batch size, so the same file becomes about
 * 36 round trips, spread across the pool.
 *
 * Deterministic _ids (utils/ids.js) are what make that possible: a policy can
 * reference a carrier in the same batch that creates it, and two workers writing
 * the same carrier converge instead of colliding.
 */

const { filePath, originalName, workerIndex, workerCount, batchSize } = workerData;

// Dimension rows never change after first write, so $setOnInsert keeps them
// stable. Policies and users use $set so a re-import refreshes changed values.
const COLLECTIONS = [
  { key: "agent", model: "Agent", operator: "$setOnInsert" },
  { key: "carrier", model: "Carrier", operator: "$setOnInsert" },
  { key: "category", model: "Category", operator: "$setOnInsert" },
  { key: "user", model: "User", operator: "$set" },
  { key: "account", model: "Account", operator: "$set" },
];

function buildOps(entity, operator) {
  return {
    updateOne: {
      filter: { _id: entity._id },
      update: { [operator]: entity.set },
      upsert: true,
    },
  };
}

async function flush(batch, models) {
  if (batch.length === 0) return;

  // Deduplicate within the batch: 200 rows might reference the same carrier 200
  // times, and Mongo rejects an unordered batch containing two upserts of one _id.
  const pending = new Map(COLLECTIONS.map(({ key }) => [key, new Map()]));
  const policyOps = [];

  for (const record of batch) {
    for (const { key, operator } of COLLECTIONS) {
      const entity = record[key];
      pending.get(key).set(String(entity._id), buildOps(entity, operator));
    }
    policyOps.push({
      updateOne: {
        filter: { _id: record.policy._id },
        update: { $set: record.policy.set },
        upsert: true,
      },
    });
  }

  // Dimensions first so a policy never points at a document that does not exist
  // yet; within each call ordering does not matter, hence ordered:false.
  for (const { key, model } of COLLECTIONS) {
    const ops = [...pending.get(key).values()];
    if (ops.length) await models[model].bulkWrite(ops, { ordered: false });
  }
  await models.Policy.bulkWrite(policyOps, { ordered: false });
}

async function run() {
  await connect({
    uri: workerData.mongoUri || config.mongoUri,
    poolSize: config.mongoWorkerPoolSize,
  });

  const models = {
    Agent: require("../models/Agent"),
    User: require("../models/User"),
    Account: require("../models/Account"),
    Category: require("../models/Category"),
    Carrier: require("../models/Carrier"),
    Policy: require("../models/Policy"),
  };

  let rowIndex = -1;
  let processed = 0;
  let skipped = 0;
  const errors = [];
  let batch = [];

  const report = () => {
    parentPort.postMessage({
      type: "progress",
      workerIndex,
      threadId,
      processed,
      skipped,
      errors: errors.splice(0, errors.length),
    });
  };

  for await (const row of readRows(filePath, originalName)) {
    rowIndex += 1;
    if (rowIndex % workerCount !== workerIndex) continue;

    // +2: the header occupies line 1, and rowIndex is 0-based, so this is the
    // spreadsheet line number a human would see.
    const lineNumber = rowIndex + 2;

    let record;
    try {
      record = transformRow(row, lineNumber);
    } catch (err) {
      skipped += 1;
      errors.push({ row: lineNumber, reason: err.message });
      continue;
    }

    if (!record.ok) {
      skipped += 1;
      errors.push({ row: lineNumber, reason: record.reason });
      continue;
    }

    batch.push(record);

    if (batch.length >= batchSize) {
      await flush(batch, models);
      processed += batch.length;
      batch = [];
      report();
    }
  }

  if (batch.length) {
    await flush(batch, models);
    processed += batch.length;
    batch = [];
  }

  report();
  parentPort.postMessage({ type: "done", workerIndex, threadId, processed, skipped });

  logger.info(
    "importWorker[%d] finished: processed=%d skipped=%d",
    workerIndex,
    processed,
    skipped,
  );

  // Close the pool before exiting so in-flight writes are not cut off mid-ack.
  // The old code called process.exit(0) immediately after postMessage.
  await disconnect();
}

run().catch(async (err) => {
  logger.error("importWorker[%d] failed: %s", workerIndex, err.message || err);
  parentPort.postMessage({
    type: "failed",
    workerIndex,
    threadId,
    error: err.message || String(err),
  });
  try {
    await disconnect();
  } catch {
    /* already closing */
  }
  process.exit(1);
});
