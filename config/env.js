const requiredEnvKeys = ["JWT_SECRET", "DATABASE_URL"];

const isBlank = (value) => !String(value || "").trim();

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
