const express = require("express");
const alertKeyAuth = require("../middleware/alertKeyAuth");
const {
  standardReadLimiter,
  mediumOrderWriteLimiter,
} = require("../middleware/rateLimiters");
const {
  getAlertOrders,
  getAlertDeliveryPartners,
  updateAlertDeliveryStatus,
} = require("../controllers/alertController");
const { updateOrderStatus } = require("../controllers/orderStatusController");

const router = express.Router();

router.get("/orders", standardReadLimiter, alertKeyAuth, getAlertOrders);
router.get(
  "/orders/delivery-partners",
  standardReadLimiter,
  alertKeyAuth,
  getAlertDeliveryPartners,
);
router.put(
  "/orders/:id/status",
  mediumOrderWriteLimiter,
  alertKeyAuth,
  updateOrderStatus,
);
router.put(
  "/orders/:id/delivery-status",
  mediumOrderWriteLimiter,
  alertKeyAuth,
  updateAlertDeliveryStatus,
);

module.exports = router;
