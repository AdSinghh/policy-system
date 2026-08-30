/**
 * Builds every index declared in models/ against the configured database.
 *
 * Mongoose autoIndex would do this on boot, but that races the first import and
 * is disabled in production by convention. Run once after deploying:
 *
 *   npm run indexes
 *
 * The unique indexes matter: they are what stop a second upload of the same
 * sheet from duplicating the dataset.
 */
const mongoose = require("mongoose");
const { connect, disconnect } = require("../db/connect");
const logger = require("../utils/logger");

const MODELS = [
  "Agent",
  "User",
  "Account",
  "Category",
  "Carrier",
  "Policy",
  "ScheduledPost",
  "Post",
  "ImportJob",
];

async function main() {
  await connect();

  for (const name of MODELS) {
    require(`../models/${name}`);
  }

  for (const name of MODELS) {
    const model = mongoose.model(name);
    await model.syncIndexes();
    const indexes = await model.collection.indexes();
    logger.info(
      "%s: %s",
      name,
      indexes.map((index) => index.name + (index.unique ? " (unique)" : "")).join(", "),
    );
  }

  await disconnect();
  logger.info("Index sync complete");
}

main().catch(async (err) => {
  logger.error("Index sync failed: %s", err.message);
  await disconnect().catch(() => {});
  process.exit(1);
});
