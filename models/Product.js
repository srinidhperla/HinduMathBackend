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

const Product = mongoose.model("Product", productSchema);

module.exports = Product;
