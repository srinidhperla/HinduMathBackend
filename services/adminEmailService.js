const SiteContent = require("../models/SiteContent");
const User = require("../models/User");
const { SITE_KEY } = require("../config/constants");

const isValidEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

const parseEmailList = (value) => {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => parseEmailList(entry))
      .filter(Boolean);
  }

  return String(value || "")
    .split(",")
    .map((entry) => normalizeEmail(entry))
    .filter(Boolean)
    .filter(isValidEmail);
};

const addRecipients = (recipientMap, emails, source) => {
  parseEmailList(emails).forEach((email) => {
    const existing = recipientMap.get(email);
    if (existing) {
      existing.sources.add(source);
      return;
    }

    recipientMap.set(email, {
      email,
      sources: new Set([source]),
    });
  });
};

const getConfiguredAdminRecipientFields = (purpose = "alerts") => {
  if (purpose === "contact") {
    return [
      "ADMIN_CONTACT_EMAILS",
      "ADMIN_CONTACT_EMAIL",
      "ADMIN_ALERT_EMAILS",
      "ADMIN_ALERT_EMAIL",
    ];
  }

  return ["ADMIN_ALERT_EMAILS", "ADMIN_ALERT_EMAIL"];
};

const resolveAdminEmailRecipients = async ({
  purpose = "alerts",
  includeAdminUsers = true,
  includeSiteEmail = true,
  respectAlertPreferences = purpose === "alerts",
} = {}) => {
  const recipientMap = new Map();

  getConfiguredAdminRecipientFields(purpose).forEach((key) => {
    addRecipients(recipientMap, process.env[key], `env:${key}`);
  });

  if (includeAdminUsers) {
    const query = { role: "admin" };

    if (respectAlertPreferences) {
      query["adminAlertPreferences.alertsEnabled"] = { $ne: false };
    }

    const adminUsers = await User.find(query).select("email").lean();
    adminUsers.forEach((user) => {
      addRecipients(recipientMap, user?.email, "database:admin-user");
    });
  }

  if (includeSiteEmail) {
    const siteContent = await SiteContent.findOne({ singletonKey: SITE_KEY })
      .select("businessInfo.email")
      .lean();
    addRecipients(
      recipientMap,
      siteContent?.businessInfo?.email,
      "database:site-business-email",
    );
  }

  const recipients = [...recipientMap.values()].map((entry) => entry.email);
  const recipientDetails = [...recipientMap.values()].map((entry) => ({
    email: entry.email,
    sources: [...entry.sources],
  }));

  return {
    recipients,
    recipientDetails,
    recipientCount: recipients.length,
    recipientSourceSummary: recipientDetails
      .map((entry) => `${entry.email} (${entry.sources.join(", ")})`)
      .join("; "),
  };
};

module.exports = {
  isValidEmail,
  normalizeEmail,
  parseEmailList,
  resolveAdminEmailRecipients,
};
