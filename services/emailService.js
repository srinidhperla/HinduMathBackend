const nodemailer = require("nodemailer");
const { Resend } = require("resend");
const logger = require("../utils/logger");

const parseBoolean = (value) =>
  ["true", "1", "yes", "on"].includes(String(value || "").toLowerCase());

const readEnv = (key, fallback = "") => {
  const raw = String(process.env[key] ?? fallback).trim();
  // Render dashboard values are sometimes pasted with quotes.
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1).trim();
  }
  return raw;
};

const getConfiguredHost = () =>
  readEnv("SMTP_HOST", "smtp.gmail.com");

const getConfiguredPort = () => Number(readEnv("SMTP_PORT", "587")) || 587;

const getConfiguredSecureMode = () => {
  const secureEnv = readEnv("SMTP_SECURE");
  if (secureEnv.length > 0) {
    return parseBoolean(secureEnv);
  }
  // Default behavior: 465 uses implicit TLS, other SMTP ports use STARTTLS.
  return getConfiguredPort() === 465;
};

const getMissingSmtpFields = () =>
  ["SMTP_USER", "SMTP_PASS"].filter(
    (key) => !String(process.env[key] || "").trim(),
  );

const getResendApiKey = () => readEnv("RESEND_API_KEY");

const getResendFrom = () =>
  readEnv("EMAIL_FROM") || readEnv("SMTP_FROM") || readEnv("SMTP_USER");

const getMissingResendFields = () =>
  ["RESEND_API_KEY"].filter((key) => !readEnv(key));

const isResendConfigured = () => Boolean(getResendApiKey() && getResendFrom());
const isRenderEnvironment = () =>
  Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);

const getTransportOptions = () => {
  const host = getConfiguredHost();
  const port = getConfiguredPort();
  const user = readEnv("SMTP_USER");
  const pass = readEnv("SMTP_PASS");

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
    connectionTimeout: Number(readEnv("SMTP_CONNECTION_TIMEOUT_MS", "10000")),
    greetingTimeout: Number(readEnv("SMTP_GREETING_TIMEOUT_MS", "10000")),
    socketTimeout: Number(readEnv("SMTP_SOCKET_TIMEOUT_MS", "20000")),
  };
};

let transporter;
let resendClient;

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

const getResendClient = () => {
  if (resendClient) {
    return resendClient;
  }

  if (!isResendConfigured()) {
    return null;
  }

  resendClient = new Resend(getResendApiKey());
  return resendClient;
};

const isSmtpConfigured = () => Boolean(getTransportOptions());

const isEmailConfigured = () => isResendConfigured() || isSmtpConfigured();

const getEmailConfigurationStatus = () => ({
  configured: isEmailConfigured(),
  provider: isResendConfigured() ? "resend" : isSmtpConfigured() ? "smtp" : "none",
  renderEnvironment: isRenderEnvironment(),
  resendConfigured: isResendConfigured(),
  resendFrom: getResendFrom(),
  missingResendFields: getMissingResendFields(),
  smtpConfigured: isSmtpConfigured(),
  host: getConfiguredHost(),
  port: getConfiguredPort(),
  secure: getConfiguredSecureMode(),
  secureSource: readEnv("SMTP_SECURE").length
    ? "env"
    : "port-default",
  from: readEnv("SMTP_FROM") || readEnv("SMTP_USER"),
  missingFields: getMissingSmtpFields(),
});

const getSmtpErrorDetails = (error) => {
  const code = String(error?.code || "").trim();
  const responseCode = Number(error?.responseCode || 0) || undefined;
  const rawResponse = String(error?.response || "").trim();
  const rawMessage = String(error?.message || "").trim();
  const runningOnRender = isRenderEnvironment();

  let hint = "SMTP send failed. Check host, port, user, password, and Gmail App Password configuration.";

  if (code === "EAUTH" || responseCode === 535) {
    hint = "SMTP authentication failed. Use the Gmail App Password, not the regular Gmail password.";
  } else if (code === "ESOCKET" || code === "ETIMEDOUT") {
    hint = runningOnRender
      ? "SMTP connection failed. On Render, outbound SMTP on ports 25, 465, and 587 can be restricted depending on plan. Use an email API provider such as Resend, Brevo, or SendGrid, or move to a plan that supports your SMTP setup."
      : "SMTP connection failed. Verify smtp.gmail.com, port 587, firewall rules, and TLS settings.";
  } else if (responseCode === 550 || responseCode === 553) {
    hint = "SMTP rejected the sender or recipient address. Verify SMTP_FROM, SMTP_USER, and target email addresses.";
  } else if (code === "ERENDER_EMAIL_PROVIDER") {
    hint = "Email provider is not configured for Render. Set RESEND_API_KEY and EMAIL_FROM in Render environment variables.";
  } else if (/resend/i.test(rawMessage)) {
    hint = "Email API send failed. Verify RESEND_API_KEY, EMAIL_FROM sender, and recipient address.";
  }

  return {
    code: code || undefined,
    responseCode,
    response: rawResponse || undefined,
    message: rawMessage || undefined,
    command: error?.command || undefined,
    hint,
  };
};

const sendEmail = async (mailOptions) => {
  const runningOnRender = isRenderEnvironment();
  const activeResend = getResendClient();
  if (activeResend) {
    try {
      const from = mailOptions?.from || getResendFrom();
      const resendPayload = {
        from,
        to: mailOptions?.to,
        subject: mailOptions?.subject,
      };

      if (mailOptions?.html) resendPayload.html = mailOptions.html;
      if (mailOptions?.text) resendPayload.text = mailOptions.text;
      if (mailOptions?.cc) resendPayload.cc = mailOptions.cc;
      if (mailOptions?.bcc) resendPayload.bcc = mailOptions.bcc;
      if (mailOptions?.replyTo) resendPayload.replyTo = mailOptions.replyTo;

      const response = await activeResend.emails.send(resendPayload);
      return {
        ...response,
        provider: "resend",
      };
    } catch (error) {
      logger.error("Resend send failed", {
        error: error?.message || String(error),
        to: mailOptions?.to || "",
        subject: mailOptions?.subject || "",
      });
      throw error;
    }
  }

  if (runningOnRender) {
    logger.error("Email send blocked: Resend is required on Render", {
      missingResendFields: getMissingResendFields(),
      resendFrom: getResendFrom(),
      to: mailOptions?.to || "",
      subject: mailOptions?.subject || "",
    });
    const error = new Error(
      "Resend is not configured on Render. Set RESEND_API_KEY and EMAIL_FROM.",
    );
    error.code = "ERENDER_EMAIL_PROVIDER";
    throw error;
  }

  const activeTransporter = getTransporter();
  if (!activeTransporter) {
    const missingFields = getMissingSmtpFields();
    logger.warn("Email not configured. No Resend or SMTP credentials.", {
      missingResendFields: getMissingResendFields(),
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
      from: readEnv("SMTP_FROM") || readEnv("SMTP_USER"),
      ...mailOptions,
    });
  } catch (error) {
    const smtpError = getSmtpErrorDetails(error);
    logger.error("SMTP send failed", {
      error: error.message,
      host: getConfiguredHost(),
      port: getConfiguredPort(),
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
