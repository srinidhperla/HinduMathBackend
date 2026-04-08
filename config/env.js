const requiredEnvKeys = ["JWT_SECRET", "DATABASE_URL"];

const isBlank = (value) => !String(value || "").trim();

const isWeakSecret = (value) => {
  const str = String(value || "").trim();
  // Check for minimum length and basic complexity
  return str.length < 32;
};

const applyEnvAliases = () => {
  // Support legacy names so older local env files still work.
  if (isBlank(process.env.DATABASE_URL) && !isBlank(process.env.MONGODB_URI)) {
    process.env.DATABASE_URL = process.env.MONGODB_URI;
  }

  if (
    isBlank(process.env.RAZORPAY_KEY) &&
    !isBlank(process.env.RAZORPAY_KEY_ID)
  ) {
    process.env.RAZORPAY_KEY = process.env.RAZORPAY_KEY_ID;
  }
};

const validateEnv = () => {
  applyEnvAliases();

  const missingKeys = requiredEnvKeys.filter((key) =>
    isBlank(process.env[key]),
  );

  if (missingKeys.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingKeys.join(", ")}`,
    );
  }

  // Warn about weak JWT_SECRET in production
  if (process.env.NODE_ENV === "production") {
    if (isWeakSecret(process.env.JWT_SECRET)) {
      console.warn(
        "⚠️  WARNING: JWT_SECRET should be at least 32 characters for production security.",
      );
    }
  }

  const hasRazorpayKey = !isBlank(process.env.RAZORPAY_KEY);
  const hasRazorpaySecret = !isBlank(process.env.RAZORPAY_KEY_SECRET);

  if (
    (hasRazorpayKey && !hasRazorpaySecret) ||
    (!hasRazorpayKey && hasRazorpaySecret)
  ) {
    throw new Error(
      "Razorpay configuration incomplete. Set both RAZORPAY_KEY and RAZORPAY_KEY_SECRET, or leave both empty.",
    );
  }
};

module.exports = { validateEnv };
