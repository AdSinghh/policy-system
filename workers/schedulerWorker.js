const { parentPort, workerData, threadId } = require("worker_threads");

const config = require("../config");
const logger = require("../utils/logger");
const { connect, disconnect } = require("../db/connect");

/**
 * Delivers scheduled messages.
 *
 * Everything durable lives in Mongo, which matters here specifically because
 * Task 2.1 restarts this process on CPU pressure — the thread dies with its
 * cluster worker and a replacement resumes from the same collection. An
 * in-memory timer would silently drop every pending message on each restart.
 *
 * Claims are atomic. The previous implementation ran find() and then updated
 * each document, so two schedulers could both see the same pending row and
 * deliver it twice; that was only safe because exactly one worker was ever
 * forked. A single findOneAndUpdate makes the claim the same operation as the
 * read, so extra schedulers are harmless.
 */

let running = true;
let timer = null;

async function reclaimStaleClaims(ScheduledPost) {
  const cutoff = new Date(Date.now() - config.scheduler.claimTimeoutMs);

  const result = await ScheduledPost.updateMany(
    { status: "processing", claimedAt: { $lt: cutoff } },
    { $set: { status: "pending" }, $unset: { claimedAt: "", claimedBy: "" } },
  );

  if (result.modifiedCount > 0) {
    logger.warn(
      "Reclaimed %d scheduled message(s) abandoned by a previous process",
      result.modifiedCount,
    );
  }
}

async function claimNext(ScheduledPost, now) {
  return ScheduledPost.findOneAndUpdate(
    { status: "pending", runAt: { $lte: now } },
    {
      $set: { status: "processing", claimedAt: new Date(), claimedBy: `thread-${threadId}` },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { runAt: 1 } },
  );
}

async function deliver(doc, ScheduledPost, Post) {
  try {
    const post = await Post.create({
      message: doc.message,
      scheduledPostId: doc._id,
      scheduledFor: doc.runAt,
      publishedAt: new Date(),
    });

    await ScheduledPost.updateOne(
      { _id: doc._id },
      {
        $set: { status: "completed", postId: post._id, deliveredAt: new Date() },
        $unset: { claimedAt: "", claimedBy: "", lastError: "" },
      },
    );

    parentPort?.postMessage({ type: "delivered", scheduleId: doc._id, postId: post._id });
    logger.info(
      "Delivered scheduled message %s (%dms after due)",
      doc._id,
      Date.now() - doc.runAt.getTime(),
    );
  } catch (err) {
    // Give up after maxAttempts rather than retrying a poison message forever.
    const exhausted = doc.attempts >= config.scheduler.maxAttempts;

    await ScheduledPost.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: exhausted ? "failed" : "pending",
          lastError: err.message,
        },
        $unset: { claimedAt: "", claimedBy: "" },
      },
    );

    logger.error(
      "Delivery failed for %s (attempt %d/%d): %s",
      doc._id,
      doc.attempts,
      config.scheduler.maxAttempts,
      err.message,
    );
  }
}

async function tick(ScheduledPost, Post) {
  await reclaimStaleClaims(ScheduledPost);

  const now = new Date();
  let delivered = 0;

  // Drain everything already due, bounded so one pass cannot run forever.
  while (running && delivered < config.scheduler.batchSize) {
    const doc = await claimNext(ScheduledPost, now);
    if (!doc) break;
    await deliver(doc, ScheduledPost, Post);
    delivered += 1;
  }

  return delivered;
}

async function run() {
  await connect({
    uri: workerData?.mongoUri || config.mongoUri,
    poolSize: config.mongoWorkerPoolSize,
  });

  const ScheduledPost = require("../models/ScheduledPost");
  const Post = require("../models/Post");

  logger.info(
    "Scheduler started (poll every %dms)",
    config.scheduler.pollIntervalMs,
  );

  // Self-rescheduling rather than setInterval: a slow pass delays the next one
  // instead of overlapping with it.
  const loop = async () => {
    if (!running) return;
    try {
      await tick(ScheduledPost, Post);
    } catch (err) {
      logger.error("Scheduler poll failed: %s", err.message);
    }
    if (running) {
      timer = setTimeout(loop, config.scheduler.pollIntervalMs);
    }
  };

  await loop();
}

async function shutdown() {
  running = false;
  if (timer) clearTimeout(timer);
  try {
    await disconnect();
  } catch {
    /* already closing */
  }
}

parentPort?.on("message", (message) => {
  if (message?.type === "shutdown") shutdown();
});

run().catch(async (err) => {
  logger.error("Scheduler failed to start: %s", err.message);
  parentPort?.postMessage({ type: "failed", error: err.message });
  await shutdown();
  process.exit(1);
});
