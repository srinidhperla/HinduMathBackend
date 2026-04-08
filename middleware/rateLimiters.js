const rateLimit = require("express-rate-limit");

const createLimiter = (max, message) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message },
  });

// IP-based rate limiter for auth endpoints
const strictAuthLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 5, // 5 requests per minute for auth
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many authentication attempts, please try again later." },
});

// Account-based rate limiter to prevent credential stuffing
// Tracks failed attempts per email address
const failedLoginAttempts = new Map();
const ACCOUNT_LOCKOUT_THRESHOLD = 5;
const ACCOUNT_LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

const accountLockoutMiddleware = (req, res, next) => {
  const email = String(req.body?.email || "").toLowerCase().trim();
  if (!email) {
    return next();
  }

  const attempts = failedLoginAttempts.get(email);
  if (attempts && attempts.count >= ACCOUNT_LOCKOUT_THRESHOLD) {
    const timeSinceLockout = Date.now() - attempts.lockedAt;
    if (timeSinceLockout < ACCOUNT_LOCKOUT_DURATION_MS) {
      const minutesRemaining = Math.ceil((ACCOUNT_LOCKOUT_DURATION_MS - timeSinceLockout) / 60000);
      return res.status(429).json({
        message: `Account temporarily locked due to too many failed attempts. Try again in ${minutesRemaining} minutes.`,
      });
    }
    // Reset after lockout period
    failedLoginAttempts.delete(email);
  }

  next();
};

const recordFailedLogin = (email) => {
  const normalizedEmail = String(email || "").toLowerCase().trim();
  if (!normalizedEmail) return;

  const existing = failedLoginAttempts.get(normalizedEmail) || { count: 0 };
  existing.count += 1;
  if (existing.count >= ACCOUNT_LOCKOUT_THRESHOLD) {
    existing.lockedAt = Date.now();
  }
  failedLoginAttempts.set(normalizedEmail, existing);
};

const clearFailedLogins = (email) => {
  const normalizedEmail = String(email || "").toLowerCase().trim();
  if (normalizedEmail) {
    failedLoginAttempts.delete(normalizedEmail);
  }
};

const mediumOrderWriteLimiter = createLimiter(
  100,
  "Too many order requests, please try again in a few minutes.",
);

const standardReadLimiter = createLimiter(
  500,
  "Too many API requests, please slow down and retry.",
);

module.exports = {
  strictAuthLimiter,
  mediumOrderWriteLimiter,
  standardReadLimiter,
  accountLockoutMiddleware,
  recordFailedLogin,
  clearFailedLogins,
};
