const crypto = require("crypto");

const readIncomingPrivateKey = (req) => {
  const headerKey = String(req.header("x-alert-key") || "").trim();
  if (headerKey) {
    return headerKey;
  }

  const authorization = String(req.header("authorization") || "").trim();
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return "";
};

const safeCompare = (receivedValue, expectedValue) => {
  const receivedBuffer = Buffer.from(receivedValue, "utf8");
  const expectedBuffer = Buffer.from(expectedValue, "utf8");

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
};

const alertKeyAuth = (req, res, next) => {
  const expectedKey = String(process.env.ALERT_ORDERS_PRIVATE_KEY || "").trim();

  if (!expectedKey) {
    return res.status(503).json({
      message:
        "Alert API is not configured. Set ALERT_ORDERS_PRIVATE_KEY environment variable.",
    });
  }

  const receivedKey = readIncomingPrivateKey(req);

  if (!receivedKey || !safeCompare(receivedKey, expectedKey)) {
    return res.status(401).json({
      message: "Unauthorized alert key",
    });
  }

  return next();
};

module.exports = alertKeyAuth;
