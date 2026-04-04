const mongoose = require("mongoose");

const adminAlertDeviceSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    platform: {
      type: String,
      trim: true,
      default: "android",
    },
    source: {
      type: String,
      trim: true,
      default: "mobile-alert-app",
    },
    userAgent: {
      type: String,
      trim: true,
      default: "",
    },
    appVersion: {
      type: String,
      trim: true,
      default: "",
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

module.exports =
  mongoose.models.AdminAlertDevice ||
  mongoose.model("AdminAlertDevice", adminAlertDeviceSchema);
