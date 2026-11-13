const mongoose = require("mongoose");

/* ── Purchase bills ───────────────────────────────────────────────────────
 * A supplier's bill for stock the shop bought: who sold it, the bill number
 * and date, and each item line with its billing category, so purchases can
 * be totalled category-wise and the GST paid (input tax) can be shown.
 *
 * Rates on supplier bills are before tax: a line's taxable value is
 *   qty × rate − discount, and GST is added on top at the line's rate.
 * Within the state GST splits into CGST + SGST; from another state it is IGST.
 * The supplier's printed total is kept beside the worked-out total so a
 * mistyped or misread line shows up as a difference.
 * ────────────────────────────────────────────────────────────────────────── */

const purchaseLineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // The name exactly as printed on the supplier's bill ("CDM 44G RS.45"),
    // used to recognise the item on the next bill.
    printedName: { type: String, trim: true, default: "" },
    // The stock item this line adds to.
    stockItemId: { type: String, default: "" },
    // What the shop sells one unit for (from the bill or entered).
    sellingPrice: { type: Number, default: null },
    // Stock units per one billed unit (Box of 24 pcs → 24; 500 g in kg →
    // 0.5), and the stock unit itself. Stock moves by (qty + free) × factor.
    unitFactor: { type: Number, default: 1 },
    baseUnit: { type: String, default: "pcs" },
    // How the shop sells this item, as set on this bill.
    sellOptions: {
      type: [
        new mongoose.Schema(
          { label: String, qty: Number, price: Number },
          { _id: false },
        ),
      ],
      default: [],
    },
    hsnCode: { type: String, trim: true, default: "" },
    categoryId: { type: String, default: "" },
    category: { type: String, default: "" },
    qty: { type: Number, required: true, min: 0 },
    // Units given free on top of qty (scheme goods); not charged.
    freeQty: { type: Number, default: 0, min: 0 },
    // Pieces in one unit (a box of 24 → 24), when known.
    packSize: { type: Number, default: null },
    mrp: { type: Number, default: null },
    unit: { type: String, trim: true, default: "" },
    rate: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    gstRate: { type: Number, default: 0, min: 0 },
    taxable: { type: Number, default: 0 },
    gst: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
  },
  { _id: false },
);

const attachmentSchema = new mongoose.Schema(
  {
    url: { type: String, default: "" },
    publicId: { type: String, default: "" },
    resourceType: { type: String, default: "" },
    mimeType: { type: String, default: "" },
    fileName: { type: String, default: "" },
  },
  { _id: false },
);

const purchaseSchema = new mongoose.Schema(
  {
    supplierName: { type: String, required: true, trim: true },
    supplierGstin: { type: String, trim: true, default: "" },
    supplierPhone: { type: String, trim: true, default: "" },
    invoiceNo: { type: String, trim: true, default: "" },
    // Bill date as YYYY-MM-DD (India time), like billing bills.
    dateKey: { type: String, required: true, index: true },
    taxType: { type: String, enum: ["intra", "inter"], default: "intra" },

    lines: { type: [purchaseLineSchema], default: [] },

    taxable: { type: Number, default: 0 },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    gst: { type: Number, default: 0 },
    otherCharges: { type: Number, default: 0 },
    // Deducted from the bill after tax (credit notes, cash discount).
    lessDiscount: { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    // The total printed on the supplier's bill, if known.
    billTotal: { type: Number, default: null },

    notes: { type: String, trim: true, default: "" },
    source: { type: String, enum: ["manual", "ai"], default: "manual" },
    // First file, kept for older records; every page is in attachments.
    attachment: attachmentSchema,
    attachments: { type: [attachmentSchema], default: [] },

    createdById: { type: String, default: "" },
    createdByName: { type: String, default: "" },
  },
  { collection: "billing_purchases", timestamps: true },
);

purchaseSchema.index({ supplierName: 1, dateKey: -1 });

module.exports =
  mongoose.models.BillingPurchase ||
  mongoose.model("BillingPurchase", purchaseSchema);
