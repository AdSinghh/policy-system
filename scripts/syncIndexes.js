// Synchronizes Mongoose schema indexes with MongoDB.

// "I use this script to ensure the indexes defined in my schemas exist correctly in MongoDB."
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
      indexes
        .map((index) => index.name + (index.unique ? " (unique)" : ""))
        .join(", "),
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
