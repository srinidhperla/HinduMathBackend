const logger = require("../utils/logger");

const requestLogger = (req, res, next) => {
  const startTime = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - startTime;
    const userId = req.user?._id?.toString?.() || "anonymous";

    logger.info("HTTP request", {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs,
      userId,
      ip: req.ip,
      userAgent: req.get("user-agent") || "unknown",
    });
  });

  next();
};

module.exports = requestLogger;
