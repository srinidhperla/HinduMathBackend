const express = require("express");
const upload = require("../middleware/upload");

const router = express.Router();
const { auth, requireRole } = require("../middleware/auth");
const {
  standardReadLimiter,
  mediumOrderWriteLimiter,
} = require("../middleware/rateLimiters");
const { getErpState, putErpState } = require("../controllers/erpStateController");
const {
  listErpOrders,
  updateErpOrderStatus,
  linkErpOrderBill,
} = require("../controllers/erpOrderController");
const {
  uploadErpImages,
  deleteErpImage,
} = require("../controllers/erpUploadController");
const {
  listErpUsers,
  updateErpUser,
  createErpUser,
  setErpUserActive,
  deleteErpUser,
  listAuditLog,
} = require("../controllers/erpUserController");

// Staff roles allowed into the ERP. Customers ("user") and delivery partners
// are deliberately excluded.
const isErpStaff = requireRole("admin", "owner", "manager", "cashier", "production");

router.get("/state", auth, isErpStaff, standardReadLimiter, getErpState);
router.put("/state", auth, isErpStaff, mediumOrderWriteLimiter, putErpState);

// Website orders, for the counter
router.get("/orders", auth, isErpStaff, standardReadLimiter, listErpOrders);
router.put(
  "/orders/:id/status",
  auth,
  isErpStaff,
  mediumOrderWriteLimiter,
  updateErpOrderStatus,
);
router.put(
  "/orders/:id/bill",
  auth,
  isErpStaff,
  mediumOrderWriteLimiter,
  linkErpOrderBill,
);

// Product images — any ERP staff member adding a product needs this
router.post(
  "/upload",
  auth,
  isErpStaff,
  mediumOrderWriteLimiter,
  upload.array("images", 6),
  uploadErpImages,
);
router.delete("/upload", auth, isErpStaff, mediumOrderWriteLimiter, deleteErpImage);

// Staff & permissions — owners/admins only
const isErpOwner = requireRole("admin", "owner");

router.get("/users", auth, isErpOwner, standardReadLimiter, listErpUsers);
router.put(
  "/users/:id",
  auth,
  isErpOwner,
  mediumOrderWriteLimiter,
  updateErpUser,
);
router.post("/users", auth, isErpOwner, mediumOrderWriteLimiter, createErpUser);
router.put(
  "/users/:id/active",
  auth,
  isErpOwner,
  mediumOrderWriteLimiter,
  setErpUserActive,
);
router.delete("/users/:id", auth, isErpOwner, mediumOrderWriteLimiter, deleteErpUser);
router.get("/audit", auth, isErpOwner, standardReadLimiter, listAuditLog);

module.exports = router;
