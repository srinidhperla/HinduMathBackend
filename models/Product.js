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
    rating: {
      type: Number,
      min: 0,
      max: 5,
      default: 0,
    },
    reviews: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        rating: {
          type: Number,
          required: true,
          min: 1,
          max: 5,
        },
        comment: String,
        date: {
          type: Date,
          default: Date.now,
        },
      },
    ],
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

const Product = mongoose.model("Product", productSchema);

module.exports = Product;
