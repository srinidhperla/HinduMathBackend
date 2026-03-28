const express = require("express");
const alertKeyAuth = require("../middleware/alertKeyAuth");
const { standardReadLimiter } = require("../middleware/rateLimiters");
const { getAlertOrders } = require("../controllers/alertController");

const router = express.Router();

router.get("/orders", standardReadLimiter, alertKeyAuth, getAlertOrders);

module.exports = router;
