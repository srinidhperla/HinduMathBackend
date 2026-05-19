const {
  getReminderStatus,
  sendTestReminderEmail,
} = require("../services/orderReminderService");
const { getEmailErrorDetails } = require("../services/emailService");
const logger = require("../utils/logger");

exports.sendTestAlertEmail = async (req, res) => {
  try {
    const emailStatus = await getReminderStatus();
    const result = await sendTestReminderEmail();

    if (result.skipped) {
      return res.status(400).json({
        message:
          result.reason === "email-not-configured"
            ? "Email service is not configured yet."
            : "Admin alert email recipient is not configured.",
        emailStatus,
      });
    }

    return res.json({
      message: `Test alert email sent to ${result.recipients?.join(", ") || result.recipient}`,
      ...result,
      emailStatus,
    });
  } catch (error) {
    const emailError = getEmailErrorDetails(error);
    const emailStatus = await getReminderStatus().catch(() => null);
    logger.error("Test alert email failed", {
      error: error?.message || String(error),
      code: emailError.code,
      responseCode: emailError.responseCode,
      hint: emailError.hint,
      emailStatus,
    });
    const statusCode =
      emailError.code === "EAUTH" ||
      emailError.code === "ESOCKET" ||
      emailError.code === "ETIMEDOUT"
        ? 503
        : 500;

    return res.status(statusCode).json({
      message: emailError.hint,
      error: error.message,
      code: emailError.code,
      responseCode: emailError.responseCode,
      emailStatus,
    });
  }
};
