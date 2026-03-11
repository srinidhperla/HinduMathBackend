const logger = require("../utils/logger");

const errorHandler = (err, req, res, next) => {
  logger.error("Unhandled request error", {
    message: err.message,
    stack: err.stack,
    method: req.method,
    path: req.originalUrl,
    userId: req.user?._id?.toString?.() || "anonymous",
  });
  const statusCode = err.statusCode || 500;
  const message =
    process.env.NODE_ENV === "production"
      ? "Something went wrong!"
      : err.message || "Something went wrong!";
  res.status(statusCode).json({ message });
};

module.exports = errorHandler;
