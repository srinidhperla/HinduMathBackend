const express = require("express");
const router = express.Router();
const { auth, isAdmin } = require("../middleware/auth");
const upload = require("../middleware/upload");
const {
  getSiteContent,
  updateSettings,
  updateCategoryOrder,
  getAlertStatus,
  getPushAlertStatus,
  getAdminAlertPreferences,
  updateAdminAlertPreferences,
  getPaymentStatus,
  subscribePushAlerts,
  unsubscribePushAlerts,
  subscribeFcmAlerts,
  unsubscribeFcmAlerts,
} = require("../controllers/siteController");
const { sendTestAlertEmail } = require("../controllers/siteAlertEmailController");
const { sendContactMessage } = require("../controllers/siteContactController");
const {
  addGalleryItem,
  updateGalleryItem,
  deleteGalleryItem,
} = require("../controllers/siteGalleryController");
const { strictAuthLimiter } = require("../middleware/rateLimiters");
const { cacheResponse } = require("../middleware/responseCache");

router.get(
  "/",
  cacheResponse({ key: "site", ttlSeconds: 300 }),
  getSiteContent,
);
router.get("/alerts/status", auth, isAdmin, getAlertStatus);
router.get("/alerts/push-status", auth, isAdmin, getPushAlertStatus);
router.get("/alerts/preferences", auth, isAdmin, getAdminAlertPreferences);
router.put("/alerts/preferences", auth, isAdmin, updateAdminAlertPreferences);
router.get("/payments/status", auth, isAdmin, getPaymentStatus);
router.put("/settings", auth, isAdmin, updateSettings);
router.put("/category-order", auth, isAdmin, updateCategoryOrder);
router.post("/alerts/push-subscriptions", auth, isAdmin, subscribePushAlerts);
router.post("/alerts/fcm-tokens", auth, isAdmin, subscribeFcmAlerts);
router.post("/alerts/test-email", auth, isAdmin, sendTestAlertEmail);
router.delete(
  "/alerts/push-subscriptions",
  auth,
  isAdmin,
  unsubscribePushAlerts,
);
router.delete("/alerts/fcm-tokens", auth, isAdmin, unsubscribeFcmAlerts);
router.post("/gallery", auth, isAdmin, upload.single("image"), addGalleryItem);
router.put(
  "/gallery/:itemId",
  auth,
  isAdmin,
  upload.single("image"),
  updateGalleryItem,
);
router.delete("/gallery/:itemId", auth, isAdmin, deleteGalleryItem);
router.post("/contact", strictAuthLimiter, sendContactMessage);

module.exports = router;
