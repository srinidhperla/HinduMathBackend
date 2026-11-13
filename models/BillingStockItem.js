const mongoose = require("mongoose");

/* ── Stock items ──────────────────────────────────────────────────────────
 * One record per product the shop buys from suppliers (Cadbury Dairy Milk
 * 44g, Green Peas …). Every purchase bill line is linked to one, so a
 * second bill for the same product adds to its stock instead of creating a
 * new name. The different ways suppliers print the product ("CDM 44G
 * RS.45") are kept as aliases in billing_purchase_items.
 *
 * Units:
 *   baseUnit    — what stock is counted in: pcs, kg or litre.
 *   packUnits   — how suppliers sell it, in base units: Box = 24 (pcs),
 *                 Bag = 5 (kg). A bill line in a pack converts to base units.
 *   sellOptions — how the shop sells it: 1 pc ₹45, Box (24) ₹1,000,
 *                 250 g (0.25 kg) ₹60. Set on purchase bills; used by sales.
 * stockQty, mrp and lastRate are per base unit.
 * ────────────────────────────────────────────────────────────────────────── */

const packUnitSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    factor: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const sellOptionSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    qty: { type: Number, required: true, min: 0 },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const stockItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true, index: true },
    categoryId: { type: String, default: "" },
    hsnCode: { type: String, default: "" },
    gstRate: { type: Number, default: 0 },
    baseUnit: { type: String, enum: ["pcs", "kg", "litre"], default: "pcs" },
    packUnits: { type: [packUnitSchema], default: [] },
    sellOptions: { type: [sellOptionSchema], default: [] },
    // Older fields, kept for items saved before units: the unit as billed
    // and pieces per pack.
    unit: { type: String, default: "" },
    packSize: { type: Number, default: null },
    mrp: { type: Number, default: null },
    sellingPrice: { type: Number, default: null },
    lastRate: { type: Number, default: null },
    lastSupplier: { type: String, default: "" },
    lastPurchasedOn: { type: String, default: "" },
    stockQty: { type: Number, default: 0 },
    purchasedQty: { type: Number, default: 0 },
    // Taken off by counter and auto bills (net of cancelled bills).
    soldQty: { type: Number, default: 0 },
    // Net change from stock counts (counted − expected), see adjustments.
    adjustedQty: { type: Number, default: 0 },
    // Shown as "Low" at or below this (base units). Null = one box, or a
    // fifth of what was bought, whichever the item has.
    reorderLevel: { type: Number, default: null },
  },
  { collection: "billing_stock_items", timestamps: true },
);

module.exports =
  mongoose.models.BillingStockItem ||
  mongoose.model("BillingStockItem", stockItemSchema);
