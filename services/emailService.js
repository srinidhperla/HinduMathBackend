const nodemailer = require("nodemailer");
const logger = require("../utils/logger");

const parseBoolean = (value) =>
  ["true", "1", "yes", "on"].includes(String(value || "").toLowerCase());

const getConfiguredHost = () =>
  String(process.env.SMTP_HOST || "smtp.gmail.com").trim();

const getConfiguredPort = () => Number(process.env.SMTP_PORT || 587);

const getConfiguredSecureMode = () => {
  const secureEnv = String(process.env.SMTP_SECURE || "").trim();
  return secureEnv.length > 0 ? parseBoolean(process.env.SMTP_SECURE) : false;
};

const getMissingSmtpFields = () =>
  ["SMTP_USER", "SMTP_PASS"].filter(
    (key) => !String(process.env[key] || "").trim(),
  );

const getTransportOptions = () => {
  const host = getConfiguredHost();
  const port = getConfiguredPort();
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
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
    tls: {
      rejectUnauthorized: false,
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
  host: getConfiguredHost(),
  port: getConfiguredPort(),
  secure: getConfiguredSecureMode(),
  secureSource: String(process.env.SMTP_SECURE || "").trim().length
    ? "env"
    : "port-default",
  from: process.env.SMTP_FROM || process.env.SMTP_USER || "",
  missingFields: getMissingSmtpFields(),
});

const getSmtpErrorDetails = (error) => {
  const code = String(error?.code || "").trim();
  const responseCode = Number(error?.responseCode || 0) || undefined;
  const rawResponse = String(error?.response || "").trim();
  const isRenderEnvironment = Boolean(
    process.env.RENDER || process.env.RENDER_SERVICE_ID,
  );

  let hint = "SMTP send failed. Check host, port, user, password, and Gmail App Password configuration.";

  if (code === "EAUTH" || responseCode === 535) {
    hint = "SMTP authentication failed. Use the Gmail App Password, not the regular Gmail password.";
  } else if (code === "ESOCKET" || code === "ETIMEDOUT") {
    hint = isRenderEnvironment
      ? "SMTP connection failed. On Render, outbound SMTP on ports 25, 465, and 587 can be restricted depending on plan. Use an email API provider such as Resend, Brevo, or SendGrid, or move to a plan that supports your SMTP setup."
      : "SMTP connection failed. Verify smtp.gmail.com, port 587, firewall rules, and TLS settings.";
  } else if (responseCode === 550 || responseCode === 553) {
    hint = "SMTP rejected the sender or recipient address. Verify SMTP_FROM, SMTP_USER, and target email addresses.";
  }

  return {
    code: code || undefined,
    responseCode,
    response: rawResponse || undefined,
    command: error?.command || undefined,
    hint,
  };
};

const sendEmail = async (mailOptions) => {
  const activeTransporter = getTransporter();
  if (!activeTransporter) {
    const missingFields = getMissingSmtpFields();
    logger.warn("SMTP not configured. Email skipped.", {
      host: getConfiguredHost(),
      port: getConfiguredPort(),
      secure: getConfiguredSecureMode(),
      missingFields,
      to: mailOptions?.to || "",
      subject: mailOptions?.subject || "",
    });
    return { skipped: true, reason: "smtp-not-configured" };
  }

  try {
    return await activeTransporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      ...mailOptions,
    });
  } catch (error) {
    const smtpError = getSmtpErrorDetails(error);
    logger.error("SMTP send failed", {
      error: error.message,
      host: getConfiguredHost(),
      port: Number(process.env.SMTP_PORT || 587),
      secure: getEmailConfigurationStatus().secure,
      missingFields: getMissingSmtpFields(),
      to: mailOptions?.to || "",
      subject: mailOptions?.subject || "",
      code: smtpError.code,
      responseCode: smtpError.responseCode,
      response: smtpError.response,
      command: smtpError.command,
      hint: smtpError.hint,
    });
    throw error;
  }
};

module.exports = {
  getEmailConfigurationStatus,
  getSmtpErrorDetails,
  isEmailConfigured,
  sendEmail,
};
