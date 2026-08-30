const mongoose = require("mongoose");
const config = require("../config");
const logger = require("../utils/logger");

// Fail fast on unknown query fields rather than silently matching everything.
mongoose.set("strictQuery", true);

/**
 * Connects the current process (or worker thread) to Mongo.
 *
 * `useNewUrlParser` / `useUnifiedTopology` are gone — both became no-ops in
 * Mongoose 6 and only emit deprecation noise in 7.
 */
async function connect({ uri = config.mongoUri, poolSize = config.mongoPoolSize } = {}) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  await mongoose.connect(uri, {
    maxPoolSize: poolSize,
    serverSelectionTimeoutMS: 10000,
  });

  logger.info("Connected to MongoDB (pool=%d)", poolSize);
  return mongoose.connection;
}

async function disconnect() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.connection.close(false);
}

module.exports = { connect, disconnect };
