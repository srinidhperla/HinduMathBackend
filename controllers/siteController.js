const SiteContent = require("../models/SiteContent");
const User = require("../models/User");
const { SITE_KEY } = require("../config/constants");
const { getReminderStatus } = require("../services/orderReminderService");
const {
  getPushStatus,
  subscribeAdminPush,
  unsubscribeAdminPush,
  subscribeAdminFcm,
  unsubscribeAdminFcm,
} = require("../services/pushNotificationService");
const { emitAdminDataUpdated } = require("../services/orderEvents");
const {
  buildGalleryFieldConfigPayload,
  getGalleryFieldConfig,
  syncGalleryItemsWithFieldConfig,
} = require("../services/galleryAdminService");
const {
  getOrCreateSiteContent,
  invalidatePublicCache,
} = require("../services/siteContentService");

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
      galleryFieldConfig,
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
    if (galleryFieldConfig !== undefined) {
      const content = await getOrCreateSiteContent();
      const currentFieldConfig = getGalleryFieldConfig(content);

      Object.assign(content, updatePayload);
      content.galleryFieldConfig = buildGalleryFieldConfigPayload(
        galleryFieldConfig,
        currentFieldConfig,
      );
      syncGalleryItemsWithFieldConfig(
        content.galleryItems,
        content.galleryFieldConfig,
      );
      await content.save();

      await invalidatePublicCache({ action: "updateSettings" });
      emitAdminDataUpdated("settings", { action: "updated" });
      return res.json(content);
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

