const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  items: [
    {
      product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
        required: true,
      },
      quantity: {
        type: Number,
        required: true,
        min: 1,
      },
      size: String,
      flavor: String,
      eggType: {
        type: String,
        enum: ["egg", "eggless"],
        default: "egg",
      },
      customizations: [
        {
          name: String,
          choice: String,
          price: Number,
        },
      ],
      price: {
        type: Number,
        required: true,
      },
    },
  ],
  totalAmount: {
    type: Number,
    required: true,
  },
  orderCode: {
    type: String,
    trim: true,
    index: true,
    unique: true,
    sparse: true,
  },
  subtotal: {
    type: Number,
    required: true,
  },
  deliveryFee: {
    type: Number,
    default: 0,
  },
  discountAmount: {
    type: Number,
    default: 0,
  },
  couponCode: {
    type: String,
    trim: true,
    uppercase: true,
    default: "",
  },
  status: {
    type: String,
    enum: [
      "pending",
      "confirmed",
      "preparing",
      "ready",
      "delivered",
      "cancelled",
    ],
    default: "pending",
  },
  statusTimeline: [
    {
      status: {
        type: String,
        enum: [
          "pending",
          "confirmed",
          "preparing",
          "ready",
          "delivered",
          "cancelled",
        ],
        required: true,
      },
      updatedAt: {
        type: Date,
        default: Date.now,
      },
      actorRole: {
        type: String,
        enum: ["admin", "user", "system"],
        default: "system",
      },
    },
  ],
  paymentStatus: {
    type: String,
    enum: ["pending", "completed", "failed"],
    default: "pending",
  },
  deliveryMode: {
    type: String,
    enum: ["now", "scheduled"],
    default: "scheduled",
  },
  paymentMethod: {
    type: String,
    enum: ["cash", "card", "upi"],
    required: true,
  },
  paymentGateway: {
    type: String,
    default: "",
    trim: true,
  },
  paymentGatewayOrderId: {
    type: String,
    default: "",
    trim: true,
  },
  paymentGatewayPaymentId: {
    type: String,
    default: "",
    trim: true,
  },
  paymentGatewaySignature: {
    type: String,
    default: "",
    trim: true,
  },
  deliveryAddress: {
    label: String,
    street: String,
    phone: String,
    landmark: String,
    city: String,
    state: String,
    zipCode: String,
    placeId: String,
    lat: Number,
    lng: Number,
    formattedAddress: String,
  },
  deliveryDate: {
    type: Date,
    required: true,
  },
  deliveryTime: {
    type: String,
    required: true,
  },
  specialInstructions: String,
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  lastReminderSentAt: {
    type: Date,
    default: null,
  },
  reminderEmailCount: {
    type: Number,
    default: 0,
    min: 0,
  },
});

// Update the updatedAt timestamp before saving
orderSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

const Order = mongoose.model("Order", orderSchema);

module.exports = Order;
