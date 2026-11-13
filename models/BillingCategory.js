const mongoose = require("mongoose");

/* ── Billing categories ───────────────────────────────────────────────────
 * The tax grouping used on counter bills: a name, its HSN code and GST slab.
 * This list is separate from the website menu categories — a product keeps
 * its website category and is additionally placed in one billing category.
 *
 * A category is billed in one of two ways:
 *   - it has items   → bills list those items; each takes the category's HSN
 *                      code and GST rate
 *   - it has no items → bills carry one line named after the category
 *                      ("Chocolates"), priced from the values set here:
 *        fixed  — only these amounts may be used        (10, 20, 50)
 *        range  — any amount between min and max whose last digit is one of
 *                 endDigits ([0, 5] → 100, 105, 110 …). Older categories
 *                 without endDigits use roundTo as a step (5 → 10, 15, 20 …)
 * ────────────────────────────────────────────────────────────────────────── */

const billingCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    hsnCode: { type: String, trim: true, default: "" },
    gstRate: { type: Number, default: 0, min: 0 },
    sortOrder: { type: Number, default: 0 },

    // Product ids (as strings) placed in this category. A product is in at
    // most one category; the controller enforces that on save.
    productIds: { type: [String], default: [] },

    valueMode: {
      type: String,
      enum: ["none", "fixed", "range"],
      default: "none",
    },
    fixedValues: { type: [Number], default: [] },
    rangeMin: { type: Number, default: 0, min: 0 },
    rangeMax: { type: Number, default: 0, min: 0 },
    roundTo: { type: Number, default: 1, min: 1 },
    // HSN codes (or their first digits) whose purchases belong here, e.g.
    // ["190531", "190532"] for biscuits. Empty means just hsnCode.
    hsnPrefixes: { type: [String], default: [] },
    // Allowed last digits for a range (0–9). Empty means any digit.
    endDigits: { type: [Number], default: [] },
  },
  { collection: "billing_categories", timestamps: true },
);

billingCategorySchema.index({ name: 1 }, { unique: true });

module.exports =
  mongoose.models.BillingCategory ||
  mongoose.model("BillingCategory", billingCategorySchema);
