const { Resend } = require("resend");
const logger = require("../utils/logger");

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

const getResendApiKey = () => readEnv("RESEND_API_KEY");

const getEmailFrom = () => readEnv("EMAIL_FROM");

const getMissingResendFields = () =>
  ["RESEND_API_KEY", "EMAIL_FROM"].filter((key) => !readEnv(key));

const isResendConfigured = () => Boolean(getResendApiKey() && getEmailFrom());
let resendClient;

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

const isEmailConfigured = () => isResendConfigured();

const getEmailConfigurationStatus = () => ({
  configured: isEmailConfigured(),
  provider: isResendConfigured() ? "resend" : "none",
  resendConfigured: isResendConfigured(),
  resendFrom: getEmailFrom(),
  missingResendFields: getMissingResendFields(),
  from: getEmailFrom(),
});

const getSmtpErrorDetails = (error) => {
  const code = String(error?.code || "").trim();
  const responseCode = Number(error?.responseCode || 0) || undefined;
  const rawResponse = String(error?.response || "").trim();
  const rawMessage = String(error?.message || "").trim();
  let hint =
    "Email API send failed. Verify RESEND_API_KEY, EMAIL_FROM sender, and recipient address.";

  if (code === "ERESEND_CONFIG") {
    hint = "Email provider is not configured. Set RESEND_API_KEY and EMAIL_FROM environment variables.";
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
  const activeResend = getResendClient();
  const from = mailOptions?.from || getEmailFrom();
  if (!activeResend || !from) {
    logger.warn("Resend is not configured. Email skipped.", {
      missingResendFields: getMissingResendFields(),
      to: mailOptions?.to || "",
      subject: mailOptions?.subject || "",
    });
    return { skipped: true, reason: "email-not-configured" };
  }

  try {
    const payload = {
      from,
      to: mailOptions?.to,
      subject: mailOptions?.subject,
    };

    if (mailOptions?.html) payload.html = mailOptions.html;
    if (mailOptions?.text) payload.text = mailOptions.text;
    if (mailOptions?.cc) payload.cc = mailOptions.cc;
    if (mailOptions?.bcc) payload.bcc = mailOptions.bcc;
    if (mailOptions?.replyTo) payload.replyTo = mailOptions.replyTo;

    const response = await activeResend.emails.send(payload);
    return {
      ...response,
      provider: "resend",
    };
  } catch (error) {
    const emailError = getSmtpErrorDetails(error);
    logger.error("Resend send failed", {
      error: error?.message || String(error),
      to: mailOptions?.to || "",
      subject: mailOptions?.subject || "",
      code: emailError.code,
      responseCode: emailError.responseCode,
      response: emailError.response,
      hint: emailError.hint,
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
