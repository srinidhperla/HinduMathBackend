const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
  },
  password: {
    type: String,
    required: true,
    minlength: 6,
  },
  role: {
    type: String,
    enum: ["user", "admin"],
    default: "user",
  },
  phone: {
    type: String,
    trim: true,
  },
  address: {
    street: String,
    city: String,
    state: String,
    zipCode: String,
  },
  savedAddresses: [
    {
      label: {
        type: String,
        trim: true,
        default: "Saved address",
      },
      street: {
        type: String,
        trim: true,
      },
      city: {
        type: String,
        trim: true,
      },
      state: {
        type: String,
        trim: true,
        default: "Andhra Pradesh",
      },
      zipCode: {
        type: String,
        trim: true,
      },
      phone: {
        type: String,
        trim: true,
      },
      landmark: {
        type: String,
        trim: true,
      },
      placeId: {
        type: String,
        trim: true,
      },
      formattedAddress: {
        type: String,
        trim: true,
      },
      latitude: Number,
      longitude: Number,
      isDefault: {
        type: Boolean,
        default: false,
      },
    },
  ],
  favorites: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
    },
  ],
  pushSubscriptions: [
    {
      endpoint: {
        type: String,
        required: true,
      },
      expirationTime: {
        type: Date,
        default: null,
      },
      keys: {
        p256dh: {
          type: String,
          required: true,
        },
        auth: {
          type: String,
          required: true,
        },
      },
      createdAt: {
        type: Date,
        default: Date.now,
      },
    },
  ],
  fcmTokens: [
    {
      token: {
        type: String,
        required: true,
        trim: true,
      },
      createdAt: {
        type: Date,
        default: Date.now,
      },
      lastSeenAt: {
        type: Date,
        default: Date.now,
      },
      userAgent: {
        type: String,
        trim: true,
        default: "",
      },
    },
  ],
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model("User", userSchema);

module.exports = User;
