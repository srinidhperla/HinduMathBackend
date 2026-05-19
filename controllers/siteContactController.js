const {
  resolveAdminEmailRecipients,
} = require("../services/adminEmailService");
const { sendEmail, getEmailErrorDetails } = require("../services/emailService");
const logger = require("../utils/logger");

const escapeHtml = (value) => {
  const str = String(value || "");
  const sanitized = str.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g, "");
  return sanitized
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;")
    .replace(/\//g, "&#47;");
};

exports.sendContactMessage = async (req, res) => {
  try {
    const { name, email, phone, subject, message } = req.body;
    const trimmedEmail = String(email || "").trim();
    const trimmedPhone = String(phone || "").trim();

    if (!name || !email || !subject || !message) {
      return res
        .status(400)
        .json({ message: "Name, email, subject, and message are required." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      return res.status(400).json({ message: "Valid email is required." });
    }

    if (!/^[+]?[0-9\s-]{10,15}$/.test(trimmedPhone)) {
      return res
        .status(400)
        .json({ message: "Valid phone number is required." });
    }

    const adminRecipients = await resolveAdminEmailRecipients({
      purpose: "contact",
      includeAdminUsers: true,
      includeSiteEmail: true,
      respectAlertPreferences: false,
    });

    if (!adminRecipients.recipients.length) {
      return res.status(503).json({
        message: "Contact email recipients are not configured yet.",
      });
    }

    const result = await sendEmail({
      to: adminRecipients.recipients,
      subject: `Contact Form: ${subject}`,
      html: `
        <h2>New Contact Message</h2>
        <p><strong>Name:</strong> ${escapeHtml(name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(trimmedEmail)}</p>
        <p><strong>Phone:</strong> ${escapeHtml(trimmedPhone || "Not provided")}</p>
        <p><strong>Subject:</strong> ${escapeHtml(subject)}</p>
        <hr />
        <p>${escapeHtml(message).replace(/\n/g, "<br />")}</p>
      `,
      replyTo: trimmedEmail,
    });

    if (result?.skipped) {
      return res.status(503).json({
        message: "Email service is not configured. Please contact us directly.",
      });
    }

    return res.json({ message: "Message sent successfully." });
  } catch (error) {
    const emailError = getEmailErrorDetails(error);
    logger.error("Contact form email failed", {
      error: error?.message || String(error),
      code: emailError.code,
      responseCode: emailError.responseCode,
      hint: emailError.hint,
      to: "configured-admin-recipients",
      fromReplyTo: req.body?.email || "",
      subject: req.body?.subject || "",
    });
    return res.status(500).json({
      message:
        emailError.hint || "Failed to send message. Please try again later.",
    });
  }
};
