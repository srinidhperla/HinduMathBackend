const SiteContent = require("../models/SiteContent");
const User = require("../models/User");
const {
  getReminderStatus,
  sendTestReminderEmail,
} = require("../services/orderReminderService");
const {
  resolveAdminEmailRecipients,
} = require("../services/adminEmailService");
const {
  getPushStatus,
  subscribeAdminPush,
  unsubscribeAdminPush,
  subscribeAdminFcm,
  unsubscribeAdminFcm,
} = require("../services/pushNotificationService");
const { sendEmail, getEmailErrorDetails } = require("../services/emailService");
const { clearPublicApiCache } = require("../services/cacheStore");
const { emitAdminDataUpdated } = require("../services/orderEvents");
const { SITE_KEY } = require("../config/constants");
const imageStorage = require("../services/cloudinaryStorage");
const { processUploadedImage } = require("../services/imageProcessing");
const logger = require("../utils/logger");

const escapeHtml = (value) => {
  const str = String(value || "");
  // Remove zero-width and control characters that could be used for attacks
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

const getOrCreateSiteContent = async () => {
  let content = await SiteContent.findOne({ singletonKey: SITE_KEY });

  if (!content) {
    content = await SiteContent.create({ singletonKey: SITE_KEY });
  }

  return content;
};

const invalidatePublicCache = async (context = {}) => {
  try {
    await clearPublicApiCache();
  } catch (error) {
    logger.warn("Failed to clear public API cache after site mutation", {
      error: error?.message || String(error),
      ...context,
    });
  }
};

exports.getSiteContent = async (req, res) => {
  try {
    const content = await getOrCreateSiteContent();
    res.json(content);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching site content", error: error.message });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const {
      businessInfo,
      storeHours,
      socialLinks,
      coupons,
      deliverySettings,
      categoryOrder,
      categorySettings,
    } = req.body;
    const updatePayload = {};

    if (businessInfo !== undefined) updatePayload.businessInfo = businessInfo;
    if (storeHours !== undefined) updatePayload.storeHours = storeHours;
    if (socialLinks !== undefined) updatePayload.socialLinks = socialLinks;
    if (coupons !== undefined) updatePayload.coupons = coupons;
    if (deliverySettings !== undefined) {
      updatePayload.deliverySettings = deliverySettings;
    }
    if (categoryOrder !== undefined)
      updatePayload.categoryOrder = categoryOrder;
    if (categorySettings !== undefined) {
      updatePayload.categorySettings = categorySettings;
    }

    const content = await SiteContent.findOneAndUpdate(
      { singletonKey: SITE_KEY },
      {
        $set: updatePayload,
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    await invalidatePublicCache({ action: "updateSettings" });
    emitAdminDataUpdated("settings", { action: "updated" });
    res.json(content);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error updating settings", error: error.message });
  }
};

exports.updateCategoryOrder = async (req, res) => {
  try {
    const categoryOrder = Array.isArray(req.body?.categoryOrder)
      ? req.body.categoryOrder
          .map((entry) =>
            String(entry || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean)
      : [];

    if (!categoryOrder.length) {
      return res.status(400).json({
        message: "categoryOrder must contain at least one category",
      });
    }

    const content = await SiteContent.findOneAndUpdate(
      { singletonKey: SITE_KEY },
      { $set: { categoryOrder } },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    await invalidatePublicCache({ action: "updateCategoryOrder" });
    emitAdminDataUpdated("settings", { action: "category-order-updated" });
    return res.json({
      message: "Category order updated successfully",
      categoryOrder: content.categoryOrder || [],
    });
  } catch (error) {
    return res.status(500).json({
      message: "Error updating category order",
      error: error.message,
    });
  }
};

exports.addGalleryItem = async (req, res) => {
  try {
    const { title, description, category, likes } = req.body;
    let imageUrl = req.body.imageUrl || "";

    // Process uploaded images before storage so gallery assets stay lightweight.
    if (req.file) {
      const processedImage = await processUploadedImage(req.file);
      const fileName = `gallery-${Date.now()}-${processedImage.fileName}`;
      const result = await imageStorage.uploadFile(
        processedImage.buffer,
        fileName,
        processedImage.mimeType,
      );
      imageUrl = result.url;
    }

    const content = await getOrCreateSiteContent();

    content.galleryItems.unshift({
      title,
      description,
      category,
      imageUrl,
      likes: Number.isFinite(likes) ? likes : 0,
    });

    await content.save();
    await invalidatePublicCache({ action: "addGalleryItem" });
    emitAdminDataUpdated("settings", { action: "gallery-item-added" });
    res.status(201).json({
      ...content.galleryItems[0].toObject(),
      imageUrl: imageStorage.optimizeDeliveryUrl(
        content.galleryItems[0].imageUrl,
      ),
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error adding gallery item", error: error.message });
  }
};

exports.deleteGalleryItem = async (req, res) => {
  try {
    const content = await getOrCreateSiteContent();
    const galleryItem = content.galleryItems.id(req.params.itemId);

    if (!galleryItem) {
      return res.status(404).json({ message: "Gallery item not found" });
    }

    // Delete the image from Appwrite if it's stored there
    const fileId = imageStorage.extractFileId(galleryItem.imageUrl);
    if (fileId) {
      await imageStorage.deleteFile(fileId);
    }

    galleryItem.deleteOne();
    await content.save();
    await invalidatePublicCache({ action: "deleteGalleryItem" });
    emitAdminDataUpdated("settings", { action: "gallery-item-deleted" });

    res.json({
      message: "Gallery item deleted successfully",
      id: req.params.itemId,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting gallery item", error: error.message });
  }
};

exports.getAlertStatus = async (req, res) => {
  try {
    const [status, pushStatus] = await Promise.all([
      getReminderStatus(),
      getPushStatus(),
    ]);
    res.json({
      ...status,
      push: pushStatus,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching alert status", error: error.message });
  }
};

exports.getPushAlertStatus = async (req, res) => {
  try {
    const status = await getPushStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({
      message: "Error fetching push alert status",
      error: error.message,
    });
  }
};

exports.getAdminAlertPreferences = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(
      "adminAlertPreferences role",
    );

    if (!user || user.role !== "admin") {
      return res.status(404).json({ message: "Admin user not found" });
    }

    return res.json({
      alertsEnabled: user.adminAlertPreferences?.alertsEnabled !== false,
      updatedAt: user.adminAlertPreferences?.updatedAt || null,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Error fetching admin alert preferences",
      error: error.message,
    });
  }
};

exports.updateAdminAlertPreferences = async (req, res) => {
  try {
    if (typeof req.body?.alertsEnabled !== "boolean") {
      return res.status(400).json({
        message: "alertsEnabled must be a boolean",
      });
    }

    const user = await User.findById(req.user._id).select(
      "adminAlertPreferences role",
    );

    if (!user || user.role !== "admin") {
      return res.status(404).json({ message: "Admin user not found" });
    }

    user.adminAlertPreferences = {
      alertsEnabled: req.body.alertsEnabled,
      updatedAt: new Date(),
    };
    await user.save();

    return res.json({
      alertsEnabled: user.adminAlertPreferences.alertsEnabled,
      updatedAt: user.adminAlertPreferences.updatedAt,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Error updating admin alert preferences",
      error: error.message,
    });
  }
};

exports.subscribePushAlerts = async (req, res) => {
  try {
    const result = await subscribeAdminPush(
      req.user._id,
      req.body.subscription,
    );
    res.json(result);
  } catch (error) {
    const statusCode = /invalid|not found/i.test(error.message) ? 400 : 500;
    res.status(statusCode).json({
      message: "Error subscribing to push alerts",
      error: error.message,
    });
  }
};

exports.unsubscribePushAlerts = async (req, res) => {
  try {
    const result = await unsubscribeAdminPush(req.user._id, req.body.endpoint);
    res.json(result);
  } catch (error) {
    const statusCode = /required|not found/i.test(error.message) ? 400 : 500;
    res.status(statusCode).json({
      message: "Error unsubscribing from push alerts",
      error: error.message,
    });
  }
};

exports.subscribeFcmAlerts = async (req, res) => {
  try {
    const result = await subscribeAdminFcm(
      req.user._id,
      req.body.token,
      req.body.userAgent,
    );
    res.json(result);
  } catch (error) {
    const statusCode = /required|not found/i.test(error.message) ? 400 : 500;
    res.status(statusCode).json({
      message: "Error subscribing to FCM alerts",
      error: error.message,
    });
  }
};

exports.unsubscribeFcmAlerts = async (req, res) => {
  try {
    const result = await unsubscribeAdminFcm(req.user._id, req.body.token);
    res.json(result);
  } catch (error) {
    const statusCode = /required|not found/i.test(error.message) ? 400 : 500;
    res.status(statusCode).json({
      message: "Error unsubscribing from FCM alerts",
      error: error.message,
    });
  }
};

exports.getPaymentStatus = async (req, res) => {
  try {
    const keyId = process.env.RAZORPAY_KEY_ID || "";
    const keySecret = process.env.RAZORPAY_KEY_SECRET || "";

    res.json({
      configured: Boolean(keyId && keySecret),
      gateway: "razorpay",
      keyIdPreview: keyId ? `${keyId.slice(0, 8)}...` : "",
      hasKeyId: Boolean(keyId),
      hasKeySecret: Boolean(keySecret),
      supportedMethods: ["upi", "card"],
      cashOnDeliveryEnabled: true,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching payment status", error: error.message });
  }
};

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

    res.json({
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
    res.status(statusCode).json({
      message: emailError.hint,
      error: error.message,
      code: emailError.code,
      responseCode: emailError.responseCode,
      emailStatus,
    });
  }
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

    res.json({ message: "Message sent successfully." });
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
    res.status(500).json({
      message:
        emailError.hint || "Failed to send message. Please try again later.",
    });
  }
};
