const express = require("express");

const router = express.Router();
const { auth, requireRole } = require("../middleware/auth");
const billing = require("../controllers/billingController");

/* Counter billing. Mounted at /api/billing and already covered by the global
 * /api read limiter in server.js; the cashier rings up bills all day, so no
 * tighter write limiter is applied here.
 *
 * Customers ("user") and delivery partners never get in. */
const isBillingStaff = requireRole("admin", "owner", "manager", "cashier");
const isBillingManager = requireRole("admin", "owner", "manager");

router.use(auth, isBillingStaff);

router.get("/dashboard", billing.getDashboard);
router.get("/reports", billing.getReport);

// Items sold at the counter (the shared product catalog, flattened by size)
router.get("/catalog", billing.getCatalog);
router.post("/items", isBillingManager, billing.createItem);
router.patch("/items/:id", isBillingManager, billing.updateItem);

// Bills
router.get("/bills", billing.listBills);
router.post("/bills", billing.createBill);
router.get("/bills/:id", billing.getBill);
router.post("/bills/:id/cancel", isBillingManager, billing.cancelBill);

// Auto billing: build bills from a day's PhonePe + cash takings
router.get("/auto/batches", isBillingManager, billing.listAutoBatches);
router.post("/auto/preview", isBillingManager, billing.previewAutoBills);
router.post("/auto/commit", isBillingManager, billing.commitAutoBills);
router.post("/auto/batches/:batchId/cancel", isBillingManager, billing.cancelAutoBatch);

module.exports = router;
