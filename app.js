const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const config = require("./config");
const logger = require("./utils/logger");

/**
 * Builds the Express app and nothing else.
 *
 * No database connection, no worker threads. Those used to happen at require()
 * time, which meant `npm test` opened a live Atlas connection and leaked a
 * scheduler thread just by importing this file. server.js owns process lifecycle
 * now; this module is safe to require from a test.
 */
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Model registration must precede the routes, which resolve models at load time.
require("./models/Agent");
require("./models/User");
require("./models/Account");
require("./models/Category");
require("./models/Carrier");
require("./models/Policy");
require("./models/ScheduledPost");
require("./models/Post");
require("./models/ImportJob");

const importRoutes = require("./routes/upload");

// Both mounts hit the same router: /api/upload is the path the brief names,
// /api/imports reads better for the job-status endpoints.
app.use("/api/upload", importRoutes);
app.use("/api/imports", importRoutes);
app.use("/api/policies", require("./routes/policy"));
app.use("/api/schedules", require("./routes/schedule"));
app.use("/api/system", require("./routes/system"));

try {
  const swaggerUi = require("swagger-ui-express");
  const swaggerDocument = require("./swagger.json");
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
} catch (err) {
  logger.warn("Swagger UI unavailable: %s", err.message);
}

/** Liveness probe — deliberately cheap, for load balancers and ECS/App Runner. */
app.get("/health", (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({
    status: connected ? "ok" : "degraded",
    mongo: connected ? "connected" : "disconnected",
    uptimeSeconds: Number(process.uptime().toFixed(1)),
    pid: process.pid,
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.json({
    name: "policy-backend",
    docs: "/api-docs",
    endpoints: [
      "POST   /api/upload",
      "GET    /api/imports/:jobId",
      "GET    /api/policies/search?username=",
      "GET    /api/policies/aggregate-by-user",
      "POST   /api/schedules",
      "GET    /api/system/status",
      "GET    /health",
    ],
  });
});

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

// Terminal error handler: log the detail, return something that is not a stack trace.
app.use((err, req, res, next) => {
  logger.error("Unhandled error on %s %s: %s", req.method, req.originalUrl, err.stack || err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: config.env === "production" ? "Internal server error." : err.message,
  });
});

module.exports = app;
