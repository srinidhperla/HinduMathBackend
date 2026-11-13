const express = require("express");

const router = express.Router();
const { auth, requireRole } = require("../middleware/auth");
const multer = require("multer");
const billing = require("../controllers/billingController");
const purchases = require("../controllers/purchaseController");

// Supplier bill files: photo, PDF, Excel or CSV, checked again in the
// controller. Kept in memory and passed to Cloudinary / the AI reader.
const billFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 6 },
});

// One bill: up to 6 pages (photos / PDFs / sheets) in order.
const billFiles = (req, res, next) =>
  billFileUpload.array("files", 6)(req, res, (error) => {
    if (!error) return next();
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? "A file is over 10 MB. Use a smaller photo or PDF."
        : error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE"
          ? "Upload at most 6 pages for one bill."
          : "Could not receive the file.";
    return res.status(400).json({ message });
  });

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

// Billing categories: name, HSN code, GST slab, items or amounts
router.get("/categories", billing.listCategories);
router.post("/categories", isBillingManager, billing.createCategory);
router.patch("/categories/:id", isBillingManager, billing.updateCategory);
router.delete("/categories/:id", isBillingManager, billing.deleteCategory);

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

// Purchases: supplier bills, entered by hand or read from a file
router.get("/purchases", isBillingManager, purchases.listPurchases);
router.post("/purchases/upload", isBillingManager, billFiles, purchases.uploadPurchaseBill);
// What the reader knows: short forms on bills, items learned from saved bills
router.get("/purchases/short-names", isBillingManager, purchases.getShortNames);
router.post("/purchases/short-names", isBillingManager, purchases.saveShortName);
router.delete("/purchases/short-names/:id", isBillingManager, purchases.deleteShortName);
router.get("/purchases/learned-items", isBillingManager, purchases.listLearnedItems);
router.patch("/purchases/learned-items/:id", isBillingManager, purchases.updateLearnedItem);
router.delete("/purchases/learned-items/:id", isBillingManager, purchases.deleteLearnedItem);
// Stock items: what purchases have added
router.get("/purchases/stock", isBillingManager, purchases.listStock);
router.patch("/purchases/stock/:id", isBillingManager, purchases.updateStock);
router.post("/purchases/stock/:id/adjust", isBillingManager, purchases.adjustStock);
router.get("/purchases/stock/:id/history", isBillingManager, purchases.stockHistory);
router.get("/purchases/:id", isBillingManager, purchases.getPurchase);
router.post("/purchases", isBillingManager, purchases.createPurchase);
router.patch("/purchases/:id", isBillingManager, purchases.updatePurchase);
router.delete("/purchases/:id", isBillingManager, purchases.deletePurchase);

module.exports = router;
