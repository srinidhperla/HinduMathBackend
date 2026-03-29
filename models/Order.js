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
      cakeType: {
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
      productName: {
        type: String,
        trim: true,
        default: "",
      },
      productImage: {
        type: String,
        trim: true,
        default: "",
      },
      weight: {
        type: String,
        trim: true,
        default: "",
      },
      customMessage: {
        type: String,
        trim: true,
        default: "",
      },
      occasion: {
        type: String,
        trim: true,
        default: "",
      },
      selectedOptions: [
        {
          _id: false,
          label: {
            type: String,
            trim: true,
            default: "",
          },
          value: {
            type: String,
            trim: true,
            default: "",
          },
        },
      ],
      optionSummary: {
        type: String,
        trim: true,
        default: "",
      },
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
        enum: ["admin", "delivery", "user", "system"],
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
  clientOrderRequestId: {
    type: String,
    trim: true,
    index: true,
    sparse: true,
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
  estimatedDeliveryTime: {
    type: String,
    enum: ["15min", "30min", "45min", "1hour", "1.5hours", "2hours", "custom"],
    default: undefined,
  },
  customDeliveryTime: String,
  acceptanceMessage: String,
  rejectionReason: {
    type: String,
    enum: ["outOfStock", "tooFar", "shopClosed", "other"],
    default: undefined,
  },
  rejectionMessage: String,
  assignedDeliveryPartner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  deliveryStatus: {
    type: String,
    enum: ["pending", "outForDelivery", "delivered"],
    default: "pending",
  },
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
  pendingReminderEscalatedAt: {
    type: Date,
    default: null,
  },
});

orderSchema.pre("validate", function (next) {
  if (
    this.estimatedDeliveryTime === null ||
    this.estimatedDeliveryTime === undefined ||
    this.estimatedDeliveryTime === ""
  ) {
    this.estimatedDeliveryTime = undefined;
    this.customDeliveryTime = "";
  }

  if (
    this.rejectionReason === null ||
    this.rejectionReason === undefined ||
    this.rejectionReason === ""
  ) {
    this.rejectionReason = undefined;
  }

  next();
});

// Update the updatedAt timestamp before saving
orderSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

orderSchema.index({ status: 1, createdAt: -1 });

const Order = mongoose.model("Order", orderSchema);

module.exports = Order;
