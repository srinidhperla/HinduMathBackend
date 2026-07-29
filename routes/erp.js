const express = require("express");

const router = express.Router();
const { auth, requireRole } = require("../middleware/auth");
const {
  standardReadLimiter,
  mediumOrderWriteLimiter,
} = require("../middleware/rateLimiters");
const { getErpState, putErpState } = require("../controllers/erpStateController");

// Staff roles allowed into the ERP. Customers ("user") and delivery partners
// are deliberately excluded.
const isErpStaff = requireRole("admin", "owner", "manager", "cashier", "production");

router.get("/state", auth, isErpStaff, standardReadLimiter, getErpState);
router.put("/state", auth, isErpStaff, mediumOrderWriteLimiter, putErpState);

module.exports = router;
