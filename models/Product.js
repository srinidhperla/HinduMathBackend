const mongoose = require("mongoose");

const flavorOptionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    isAvailable: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false },
);

const weightOptionSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: true,
      trim: true,
    },
    multiplier: {
      type: Number,
      required: true,
      min: 0,
      default: 1,
    },
    isAvailable: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false },
);

const addOnOptionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      required: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    price: {
      type: Number,
      min: 0,
      required: true,
    },
    image: {
      type: String,
      trim: true,
      default: "",
    },
    isAvailable: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false },
);

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    category: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    displayOrder: {
      type: Number,
      default: 0,
      min: 0,
    },
    portionType: {
      type: String,
      enum: ["weight", "size", "pieces"],
      default: "weight",
    },
    image: {
      type: String,
      required: true,
    },
    images: {
      type: [
        {
          type: String,
          trim: true,
        },
      ],
      default: [],
    },
    flavors: [
      {
        type: String,
        trim: true,
      },
    ],
    flavorOptions: {
      type: [flavorOptionSchema],
      default: [],
    },
    sizes: [
      {
        type: String,
        trim: true,
      },
    ],
    weightOptions: {
      type: [weightOptionSchema],
      default: [],
    },
    flavorWeightAvailability: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
    variantPrices: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
    customization: {
      available: {
        type: Boolean,
        default: false,
      },
      options: [
        {
          name: String,
          choices: [String],
          price: Number,
        },
      ],
    },
    addOns: {
      type: [addOnOptionSchema],
      default: [],
    },
    occasion: [
      {
        type: String,
        trim: true,
      },
    ],
    isAvailable: {
      type: Boolean,
      default: true,
    },
    isAddon: {
      type: Boolean,
      default: false,
    },
    isEgg: {
      type: Boolean,
      default: true,
    },
    isEggless: {
      type: Boolean,
      default: false,
    },
    isFeatured: {
      type: Boolean,
      default: false,
    },

    /* ── ERP fields (added 2026-07) ──────────────────────────────────────
     * All optional with defaults so existing website documents stay valid
     * and the storefront behaves exactly as before. The ERP is the only
     * consumer of costPrice / stock / barcode. */

    // Channel control. Defaults keep every existing product on the website.
    visibility: {
      showOnWebsite: { type: Boolean, default: true },
      allowOnlineOrder: { type: Boolean, default: true },
      availableInBilling: { type: Boolean, default: true },
      isActive: { type: Boolean, default: true },
    },

    sku: {
      type: String,
      trim: true,
      uppercase: true,
    },
    barcode: {
      type: String,
      trim: true,
    },
    barcodeType: {
      type: String,
      enum: ["CODE128", "EAN13"],
      default: "CODE128",
    },

    costPrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    gstRate: {
      type: Number,
      default: 5,
      min: 0,
    },
    gstMode: {
      type: String,
      enum: ["inclusive", "exclusive"],
      default: "inclusive",
    },
    hsnCode: {
      type: String,
      trim: true,
      default: "1905",
    },

    trackStock: {
      type: Boolean,
      default: false,
    },
    stockUnit: {
      type: String,
      default: "pcs",
    },
    reorderLevel: {
      type: Number,
      default: 0,
      min: 0,
    },
    isPerishable: {
      type: Boolean,
      default: false,
    },
    shelfLifeDays: {
      type: Number,
      default: 0,
      min: 0,
    },

    // "inhouse" products are produced from a recipe; "resale" are bought in.
    productType: {
      type: String,
      enum: ["inhouse", "resale"],
      default: "inhouse",
    },

    // POS presentation only — the picture-first tile grid staff use.
    erpEmoji: {
      type: String,
      trim: true,
      default: "",
    },
    erpQuickSelect: {
      type: Boolean,
      default: false,
    },

    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    collection: "products",
  },
);

// Index for search functionality
productSchema.index({
  name: "text",
  description: "text",
  category: "text",
  occasion: "text",
});
productSchema.index({ category: 1, isAvailable: 1, displayOrder: 1 });
productSchema.index({ "visibility.showOnWebsite": 1, "visibility.isActive": 1 });
productSchema.index(
  { barcode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      barcode: { $exists: true, $type: "string", $ne: "" },
    },
  },
);
productSchema.index(
  { sku: 1 },
  {
    unique: true,
    partialFilterExpression: {
      sku: { $exists: true, $type: "string", $ne: "" },
    },
  },
);

const Product = mongoose.model("Product", productSchema);

module.exports = Product;
