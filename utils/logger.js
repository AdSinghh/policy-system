const { createLogger, format, transports } = require("winston");

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.splat(),
    format.json(),
  ),
  defaultMeta: { service: "policy-backend" },
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize({ all: true }),
        format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        format.printf(({ timestamp, level, message, stack }) => {
          return stack
            ? `${timestamp} ${level}: ${message} - ${stack}`
            : `${timestamp} ${level}: ${message}`;
        }),
      ),
    }),
  ],
});

module.exports = logger;
