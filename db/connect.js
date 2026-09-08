const mongoose = require("mongoose");
const config = require("../config");
const logger = require("../utils/logger");

mongoose.set("strictQuery", true);

async function connect({
  uri = config.mongoUri,
  poolSize = config.mongoPoolSize,
} = {}) {
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
