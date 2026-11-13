const mongoose = require("mongoose");

/* A stock count: someone counted an item and its stock was set to what was
 * on the shelf. Kept so the item's history shows why stock changed outside
 * purchase and sale bills (damage, expiry, a miscount). Quantities are in
 * the item's stock unit (pcs / kg / litre). */

const stockAdjustmentSchema = new mongoose.Schema(
  {
    stockItemId: { type: String, required: true, index: true },
    itemName: { type: String, default: "" },
    expectedQty: { type: Number, required: true },
    countedQty: { type: Number, required: true },
    diff: { type: Number, required: true },
    reason: { type: String, trim: true, default: "" },
    dateKey: { type: String, required: true },
    byId: { type: String, default: "" },
    byName: { type: String, default: "" },
  },
  { collection: "billing_stock_adjustments", timestamps: true },
);

module.exports =
  mongoose.models.BillingStockAdjustment ||
  mongoose.model("BillingStockAdjustment", stockAdjustmentSchema);
