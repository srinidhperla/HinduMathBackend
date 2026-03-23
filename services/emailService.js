const nodemailer = require("nodemailer");
const logger = require("../utils/logger");

const parseBoolean = (value) =>
  ["true", "1", "yes", "on"].includes(String(value || "").toLowerCase());

const getConfiguredPort = () => Number(process.env.SMTP_PORT || 587);

const getConfiguredSecureMode = () => {
  const port = getConfiguredPort();
  const secureEnv = String(process.env.SMTP_SECURE || "").trim();
  return secureEnv.length > 0 ? parseBoolean(process.env.SMTP_SECURE) : port === 465;
};

const getTransportOptions = () => {
  const host = process.env.SMTP_HOST;
  const port = getConfiguredPort();
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  const secure = getConfiguredSecureMode();

  return {
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
    // Keep SMTP operations from hanging indefinitely in some hosted environments.
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 20000),
  };
};

let transporter;

const getTransporter = () => {
  if (transporter) {
    return transporter;
  }

  const transportOptions = getTransportOptions();
  if (!transportOptions) {
    return null;
  }

  transporter = nodemailer.createTransport(transportOptions);
  return transporter;
};

const isEmailConfigured = () => Boolean(getTransportOptions());

const getEmailConfigurationStatus = () => ({
  configured: isEmailConfigured(),
  host: process.env.SMTP_HOST || "",
  port: getConfiguredPort(),
  secure: getConfiguredSecureMode(),
  secureSource: String(process.env.SMTP_SECURE || "").trim().length
    ? "env"
    : "port-default",
  from: process.env.SMTP_FROM || process.env.SMTP_USER || "",
});

const sendEmail = async (mailOptions) => {
  const activeTransporter = getTransporter();
  if (!activeTransporter) {
    return { skipped: true, reason: "smtp-not-configured" };
  }

  try {
    return await activeTransporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      ...mailOptions,
    });
  } catch (error) {
    logger.error("SMTP send failed", {
      error: error.message,
      host: process.env.SMTP_HOST || "",
      port: Number(process.env.SMTP_PORT || 587),
      secure: getEmailConfigurationStatus().secure,
      to: mailOptions?.to || "",
      subject: mailOptions?.subject || "",
    });
    throw error;
  }
};

module.exports = {
  getEmailConfigurationStatus,
  isEmailConfigured,
  sendEmail,
};
