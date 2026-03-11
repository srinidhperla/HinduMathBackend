const fs = require("fs");
const path = require("path");
const winston = require("winston");

const LOG_DIR = path.join(__dirname, "..", "logs");

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json(),
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: jsonFormat,
  defaultMeta: {
    service: "bakery-backend",
    environment: process.env.NODE_ENV || "development",
  },
  transports: [
    new winston.transports.File({
      filename: path.join(LOG_DIR, "error.log"),
      level: "error",
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, "combined.log"),
    }),
  ],
});

if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf(
          ({ level, message, timestamp }) =>
            `${timestamp} ${level}: ${message}`,
        ),
      ),
    }),
  );
}

module.exports = logger;
