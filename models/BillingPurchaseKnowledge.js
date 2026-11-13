const mongoose = require("mongoose");

/* ── What the purchase reader learns ──────────────────────────────────────
 * PurchaseItem  — an item as a supplier prints it ("CDM 44G RS.45") and what
 *                 it really is: full name, billing category, HSN, pack size.
 *                 Saved from every purchase bill you save, so a correction
 *                 made once is used on the next bill.
 * ShortName     — abbreviations used on bills ("CDM" = "Cadbury Dairy Milk"),
 *                 for every supplier or just one. Given to the AI with each
 *                 bill it reads.
 * supplierKey is the supplier's name in lower case without punctuation;
 * an empty supplierKey applies to every supplier.
 * ────────────────────────────────────────────────────────────────────────── */

const purchaseItemSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    supplierKey: { type: String, default: "" },
    supplierName: { type: String, default: "" },
    printedName: { type: String, default: "" },
    name: { type: String, required: true, trim: true },
    // The stock item this printed name stands for.
    stockItemId: { type: String, default: "" },
    categoryId: { type: String, default: "" },
    hsnCode: { type: String, default: "" },
    gstRate: { type: Number, default: null },
    unit: { type: String, default: "" },
    // Stock units per billed unit last time (Box of 24 → 24).
    unitFactor: { type: Number, default: null },
    packSize: { type: Number, default: null },
    lastRate: { type: Number, default: null },
    uses: { type: Number, default: 0 },
  },
  { collection: "billing_purchase_items", timestamps: true },
);
purchaseItemSchema.index({ key: 1, supplierKey: 1 }, { unique: true });

const shortNameSchema = new mongoose.Schema(
  {
    short: { type: String, required: true, trim: true },
    full: { type: String, required: true, trim: true },
    supplierKey: { type: String, default: "" },
    supplierName: { type: String, default: "" },
  },
  { collection: "billing_short_names", timestamps: true },
);
shortNameSchema.index({ short: 1, supplierKey: 1 }, { unique: true });

module.exports = {
  PurchaseItem:
    mongoose.models.BillingPurchaseItem ||
    mongoose.model("BillingPurchaseItem", purchaseItemSchema),
  ShortName:
    mongoose.models.BillingShortName ||
    mongoose.model("BillingShortName", shortNameSchema),
};
