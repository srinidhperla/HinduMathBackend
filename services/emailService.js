const { Resend } = require("resend");
const logger = require("../utils/logger");
const { parseEmailList } = require("./adminEmailService");

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

const senderNeedsVerification = () => {
  const from = getEmailFrom().toLowerCase();
  return from.endsWith("@resend.dev");
};

const getEmailConfigurationStatus = () => ({
  configured: isEmailConfigured(),
  provider: isResendConfigured() ? "resend" : "none",
  resendConfigured: isResendConfigured(),
  resendFrom: getEmailFrom(),
  missingResendFields: getMissingResendFields(),
  from: getEmailFrom(),
  senderNeedsVerification: senderNeedsVerification(),
  configurationHint: senderNeedsVerification()
    ? "EMAIL_FROM still uses a Resend onboarding sender. Use a verified sender or domain for production delivery to all recipients."
    : "",
});

const getEmailErrorDetails = (error) => {
  const code = String(error?.code || "").trim();
  const responseCode = Number(error?.responseCode || 0) || undefined;
  const rawResponse = String(error?.response || "").trim();
  const rawMessage = String(error?.message || "").trim();
  let hint =
    "Email API send failed. Verify RESEND_API_KEY, EMAIL_FROM sender, and recipient address.";

  if (code === "ERESEND_CONFIG") {
    hint =
      "Email provider is not configured. Set RESEND_API_KEY and EMAIL_FROM environment variables.";
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
  const to = parseEmailList(mailOptions?.to);
  const cc = parseEmailList(mailOptions?.cc);
  const bcc = parseEmailList(mailOptions?.bcc);
  const replyTo = parseEmailList(mailOptions?.replyTo);

  if (!activeResend || !from) {
    logger.warn("Resend is not configured. Email skipped.", {
      missingResendFields: getMissingResendFields(),
      to,
      subject: mailOptions?.subject || "",
    });
    return { skipped: true, reason: "email-not-configured" };
  }

  if (!to.length) {
    logger.warn("Email skipped because recipient list is empty.", {
      subject: mailOptions?.subject || "",
    });
    return { skipped: true, reason: "recipient-not-configured" };
  }

  if (senderNeedsVerification()) {
    logger.warn("Resend sender is using onboarding domain.", {
      from,
      to,
      subject: mailOptions?.subject || "",
      hint: "Verify your own sender/domain in Resend for production delivery.",
    });
  }

  try {
    const payload = {
      from,
      to,
      subject: mailOptions?.subject,
    };

    if (mailOptions?.html) payload.html = mailOptions.html;
    if (mailOptions?.text) payload.text = mailOptions.text;
    if (cc.length) payload.cc = cc;
    if (bcc.length) payload.bcc = bcc;
    if (replyTo.length) payload.replyTo = replyTo[0];

    const response = await activeResend.emails.send(payload);
    logger.info("Email sent successfully", {
      provider: "resend",
      from,
      to,
      cc,
      bcc,
      subject: mailOptions?.subject || "",
      emailId: response?.data?.id || response?.id || "",
    });
    return {
      ...response,
      provider: "resend",
      to,
    };
  } catch (error) {
    const emailError = getEmailErrorDetails(error);
    logger.error("Resend send failed", {
      error: error?.message || String(error),
      from,
      to,
      cc,
      bcc,
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
  getEmailErrorDetails,
  isEmailConfigured,
  sendEmail,
};
