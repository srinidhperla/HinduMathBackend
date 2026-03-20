const rateLimit = require("express-rate-limit");

const createLimiter = (max, message) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message },
  });

const strictAuthLimiter = createLimiter(
  20,
  "Too many authentication attempts, please try again later.",
);

const mediumOrderWriteLimiter = createLimiter(
  10000000,
  "Too many order requests, please try again in a few minutes.",
);

const standardReadLimiter = createLimiter(
  20000000,
  "Too many API requests, please slow down and retry.",
);

module.exports = {
  strictAuthLimiter,
  mediumOrderWriteLimiter,
  standardReadLimiter,
};
