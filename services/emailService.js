const nodemailer = require("nodemailer");

const parseBoolean = (value) =>
  ["true", "1", "yes", "on"].includes(String(value || "").toLowerCase());

const getTransportOptions = () => {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return {
    host,
    port,
    secure: parseBoolean(process.env.SMTP_SECURE),
    auth: {
      user,
      pass,
    },
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
  port: Number(process.env.SMTP_PORT || 587),
  secure: parseBoolean(process.env.SMTP_SECURE),
  from: process.env.SMTP_FROM || process.env.SMTP_USER || "",
});

const sendEmail = async (mailOptions) => {
  const activeTransporter = getTransporter();
  if (!activeTransporter) {
    return { skipped: true, reason: "smtp-not-configured" };
  }

  return activeTransporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    ...mailOptions,
  });
};

module.exports = {
  getEmailConfigurationStatus,
  isEmailConfigured,
  sendEmail,
};
