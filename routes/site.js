const express = require("express");
const router = express.Router();
const { auth, isAdmin } = require("../middleware/auth");
const upload = require("../middleware/upload");
const {
  getSiteContent,
  updateSettings,
  addGalleryItem,
  deleteGalleryItem,
  getAlertStatus,
  getPushAlertStatus,
  getPaymentStatus,
  subscribePushAlerts,
  sendTestAlertEmail,
  unsubscribePushAlerts,
} = require("../controllers/siteController");

router.get("/", getSiteContent);
router.get("/alerts/status", auth, isAdmin, getAlertStatus);
router.get("/alerts/push-status", auth, isAdmin, getPushAlertStatus);
router.get("/payments/status", auth, isAdmin, getPaymentStatus);
router.put("/settings", auth, isAdmin, updateSettings);
router.post("/alerts/push-subscriptions", auth, isAdmin, subscribePushAlerts);
router.post("/alerts/test-email", auth, isAdmin, sendTestAlertEmail);
router.delete(
  "/alerts/push-subscriptions",
  auth,
  isAdmin,
  unsubscribePushAlerts,
);
router.post("/gallery", auth, isAdmin, upload.single("image"), addGalleryItem);
router.delete("/gallery/:itemId", auth, isAdmin, deleteGalleryItem);

module.exports = router;
