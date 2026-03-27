const SiteContent = require("../models/SiteContent");
const {
  getReminderStatus,
  sendTestReminderEmail,
} = require("../services/orderReminderService");
const {
  getPushStatus,
  subscribeAdminPush,
  unsubscribeAdminPush,
  subscribeAdminFcm,
  unsubscribeAdminFcm,
} = require("../services/pushNotificationService");
const { sendEmail, getSmtpErrorDetails } = require("../services/emailService");
const { SITE_KEY } = require("../config/constants");
const appwrite = require("../services/appwriteStorage");

const getOrCreateSiteContent = async () => {
  let content = await SiteContent.findOne({ singletonKey: SITE_KEY });

  if (!content) {
    content = await SiteContent.create({ singletonKey: SITE_KEY });
  }

  return content;
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
    } = req.body;
    const updatePayload = {};

    if (businessInfo !== undefined) updatePayload.businessInfo = businessInfo;
    if (storeHours !== undefined) updatePayload.storeHours = storeHours;
    if (socialLinks !== undefined) updatePayload.socialLinks = socialLinks;
    if (coupons !== undefined) updatePayload.coupons = coupons;
    if (deliverySettings !== undefined) {
      updatePayload.deliverySettings = deliverySettings;
    }
    if (categoryOrder !== undefined) updatePayload.categoryOrder = categoryOrder;

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
          .map((entry) => String(entry || "").trim().toLowerCase())
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

    // If an image file was uploaded, store it in Appwrite
    if (req.file) {
      const ext = (req.file.originalname.match(/\.[^.]+$/) || [".jpg"])[0];
      const fileName = `gallery-${Date.now()}${ext}`;
      const result = await appwrite.uploadFile(
        req.file.buffer,
        fileName,
        req.file.mimetype,
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
    res.status(201).json(content.galleryItems[0]);
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
    const fileId = appwrite.extractFileId(galleryItem.imageUrl);
    if (fileId) {
      await appwrite.deleteFile(fileId);
    }

    galleryItem.deleteOne();
    await content.save();

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
          result.reason === "smtp-not-configured"
            ? "SMTP is not configured yet."
            : "Admin alert email recipient is not configured.",
        emailStatus,
      });
    }

    res.json({
      message: `Test alert email sent to ${result.recipient}`,
      ...result,
      emailStatus,
    });
  } catch (error) {
    const smtpError = getSmtpErrorDetails(error);
    const emailStatus = await getReminderStatus().catch(() => null);
    const statusCode =
      smtpError.code === "EAUTH" ||
      smtpError.code === "ESOCKET" ||
      smtpError.code === "ETIMEDOUT"
        ? 503
        : 500;
    res.status(statusCode).json({
      message: smtpError.hint,
      error: error.message,
      code: smtpError.code,
      responseCode: smtpError.responseCode,
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

    const adminEmail =
      process.env.ADMIN_CONTACT_EMAIL ||
      process.env.ADMIN_ALERT_EMAIL ||
      process.env.SMTP_USER ||
      "srinidhperla2004@gmail.com";

    const result = await sendEmail({
      to: adminEmail,
      subject: `Contact Form: ${subject}`,
      html: `
        <h2>New Contact Message</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${trimmedEmail}</p>
        <p><strong>Phone:</strong> ${trimmedPhone || "Not provided"}</p>
        <p><strong>Subject:</strong> ${subject}</p>
        <hr />
        <p>${message.replace(/\n/g, "<br />")}</p>
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
    res
      .status(500)
      .json({ message: "Failed to send message. Please try again later." });
  }
};
