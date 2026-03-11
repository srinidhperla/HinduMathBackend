const express = require("express");
const router = express.Router();
const { auth, isAdmin } = require("../middleware/auth");
const {
  mediumOrderWriteLimiter,
  standardReadLimiter,
} = require("../middleware/rateLimiters");
const {
  validateCreateOrder,
  validateCreatePaymentOrder,
  validateVerifyPaymentAndCreateOrder,
  validateOrderStatusUpdate,
} = require("../src/validators/orderValidator");
const {
  createOrder,
  createPaymentOrder,
  verifyPaymentAndCreateOrder,
  getUserOrders,
  getOrder,
  getAllOrders,
  getOrderAnalytics,
  updateOrderStatus,
  cancelOrder,
  streamOrders,
} = require("../controllers/orderController");

// User routes (require authentication)
router.get("/stream", auth, isAdmin, standardReadLimiter, streamOrders);
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
router.get("/:id", auth, standardReadLimiter, getOrder);
router.put("/:id/cancel", auth, mediumOrderWriteLimiter, cancelOrder);

// Admin routes
router.get("/", auth, isAdmin, standardReadLimiter, getAllOrders);
router.get("/analytics", auth, isAdmin, standardReadLimiter, getOrderAnalytics);
router.put(
  "/:id/status",
  auth,
  isAdmin,
  mediumOrderWriteLimiter,
  validateOrderStatusUpdate,
  updateOrderStatus,
);

module.exports = router;
