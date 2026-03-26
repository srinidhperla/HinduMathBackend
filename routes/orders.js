const express = require("express");
const router = express.Router();
const { auth, isAdmin, isDelivery } = require("../middleware/auth");
const {
  mediumOrderWriteLimiter,
  standardReadLimiter,
} = require("../middleware/rateLimiters");
const {
  validateCreateOrder,
  validateCreatePaymentOrder,
  validateVerifyPaymentAndCreateOrder,
  validateOrderStatusUpdate,
} = require("../validators/orderValidator");
const {
  createOrder,
  createPaymentOrder,
  verifyPaymentAndCreateOrder,
  getUserOrders,
  getOrder,
  getAllOrders,
  getOrderAnalytics,
  getDeliveryPartners,
  updateOrderStatus,
  cancelOrder,
  getDeliveryPartnerOrders,
  updateDeliveryStatus,
  streamOrders,
} = require("../controllers/orderController");

// User routes (require authentication)
router.get("/stream", auth, isAdmin, standardReadLimiter, streamOrders);
router.get(
  "/delivery/my-orders",
  auth,
  isDelivery,
  standardReadLimiter,
  getDeliveryPartnerOrders,
);
router.post(
  "/",
  auth,
  mediumOrderWriteLimiter,
  validateCreateOrder,
  createOrder,
);
router.post(
  "/payment/create",
  auth,
  mediumOrderWriteLimiter,
  validateCreatePaymentOrder,
  createPaymentOrder,
);
router.post(
  "/payment/verify",
  auth,
  mediumOrderWriteLimiter,
  validateVerifyPaymentAndCreateOrder,
  verifyPaymentAndCreateOrder,
);
router.get("/my-orders", auth, standardReadLimiter, getUserOrders);

// Admin routes
router.get("/", auth, isAdmin, standardReadLimiter, getAllOrders);
router.get("/analytics", auth, isAdmin, standardReadLimiter, getOrderAnalytics);
router.get(
  "/delivery-partners",
  auth,
  isAdmin,
  standardReadLimiter,
  getDeliveryPartners,
);
router.put(
  "/:id/status",
  auth,
  isAdmin,
  mediumOrderWriteLimiter,
  validateOrderStatusUpdate,
  updateOrderStatus,
);
router.put(
  "/:id/delivery-status",
  auth,
  isDelivery,
  mediumOrderWriteLimiter,
  updateDeliveryStatus,
);
router.put("/:id/cancel", auth, mediumOrderWriteLimiter, cancelOrder);
router.get("/:id", auth, standardReadLimiter, getOrder);

module.exports = router;
