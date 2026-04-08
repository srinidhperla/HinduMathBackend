const User = require("../models/User");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const { sendEmail, isEmailConfigured } = require("../services/emailService");
const logger = require("../utils/logger");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const normalizeEmail = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const buildAuthResponseUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  phone: user.phone,
  address: user.address,
  savedAddresses: user.savedAddresses,
});

const getFrontendBaseUrl = () => {
  const explicitUrl = String(process.env.FRONTEND_URL || "").trim();
  if (explicitUrl) {
    return explicitUrl.replace(/\/+$/, "");
  }

  const firstCorsOrigin = String(process.env.CORS_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .find(Boolean);

  if (firstCorsOrigin) {
    return firstCorsOrigin.replace(/\/+$/, "");
  }

  return "http://localhost:5173";
};

const createPasswordResetToken = () => {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  return {
    rawToken,
    tokenHash,
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
  };
};

// Generate JWT Token
const generateToken = (user) => {
  const jwtExpiresIn = process.env.JWT_EXPIRES_IN || "7d";

  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: jwtExpiresIn,
  });
};

// Register new user
exports.register = async (req, res) => {
  try {
    const { name, email, password, phone, address } = req.body;
    const normalizedEmail = normalizeEmail(email);

    // Check if user already exists
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ message: "Email already registered" });
    }

    // Create new user
    const user = new User({
      name,
      email: normalizedEmail,
      password,
      phone,
      address,
    });

    await user.save();

    // Generate token
    const token = generateToken(user);

    res.status(201).json({
      message: "User registered successfully",
      token,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error registering user", error: error.message });
  }
};

// Login user
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);

    // Find user
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Generate token
    const token = generateToken(user);

    res.json({
      message: "Login successful",
      token,
    });
  } catch (error) {
    res.status(500).json({ message: "Error logging in", error: error.message });
  }
};

// Login/register user via Google token
exports.googleLogin = async (req, res) => {
  try {
    const { token } = req.body || {};

    if (!process.env.GOOGLE_CLIENT_ID) {
      return res
        .status(500)
        .json({ message: "Google login is not configured" });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = normalizeEmail(payload?.email);
    const name = String(payload?.name || "").trim();

    if (!email) {
      return res.status(400).json({ message: "Unable to verify Google email" });
    }

    let user = await User.findOne({ email });

    if (!user) {
      user = new User({
        name: name || "Google User",
        email,
        // Placeholder password for Google-created accounts
        password: jwt.sign({ email }, process.env.JWT_SECRET).slice(0, 16),
      });
      await user.save();
    }

    const authToken = generateToken(user);

    res.json({
      message: "Login successful",
      token: authToken,
    });
  } catch (error) {
    res.status(401).json({
      message: "Google authentication failed",
      error: error.message,
    });
  }
};

// Get authenticated user for app bootstrapping
exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json(buildAuthResponseUser(user));
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error fetching current user", error: error.message });
  }
};

// Get user profile
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("-password");
    res.json(user);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching profile", error: error.message });
  }
};

// Update user profile
exports.updateProfile = async (req, res) => {
  try {
    const updates = req.body;
    delete updates.password; // Prevent password update through this route
    delete updates.role; // Never trust frontend role updates

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true, runValidators: true },
    ).select("-password");

    res.json(user);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error updating profile", error: error.message });
  }
};

exports.forgotPassword = async (req, res) => {
  const successMessage =
    "If an account with that email exists, a password reset link has been sent.";

  try {
    const normalizedEmail = normalizeEmail(req.body?.email);
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      logger.info("Password reset requested for unknown email", {
        email: normalizedEmail,
      });
      return res.json({ message: successMessage });
    }

    if (!isEmailConfigured()) {
      logger.warn("Password reset requested while email service is not configured", {
        userId: String(user._id),
        email: normalizedEmail,
      });
      return res.json({ message: successMessage });
    }

    const { rawToken, tokenHash, expiresAt } = createPasswordResetToken();
    user.passwordResetTokenHash = tokenHash;
    user.passwordResetExpiresAt = expiresAt;
    user.passwordResetRequestedAt = new Date();
    await user.save();

    const resetLink = `${getFrontendBaseUrl()}/reset-password/${rawToken}`;

    try {
      const emailResult = await sendEmail({
        to: user.email,
        subject: "Reset your Hindumatha's Cake World password",
        text: [
          `Hi ${user.name || "Customer"},`,
          "",
          "We received a request to reset your password.",
          `Reset link: ${resetLink}`,
          "",
          "This link will expire in 60 minutes.",
          "If you did not request this, you can ignore this email.",
        ].join("\n"),
        html: `
          <p>Hi ${user.name || "Customer"},</p>
          <p>We received a request to reset your password.</p>
          <p><a href="${resetLink}">Reset your password</a></p>
          <p>This link will expire in 60 minutes.</p>
          <p>If you did not request this, you can ignore this email.</p>
        `,
      });

      if (emailResult?.skipped) {
        user.passwordResetTokenHash = undefined;
        user.passwordResetExpiresAt = undefined;
        user.passwordResetRequestedAt = undefined;
        await user.save();

        logger.warn("Password reset email skipped", {
          userId: String(user._id),
          email: normalizedEmail,
          reason: emailResult.reason,
        });
      }
    } catch (error) {
      user.passwordResetTokenHash = undefined;
      user.passwordResetExpiresAt = undefined;
      user.passwordResetRequestedAt = undefined;
      await user.save();

      logger.error("Password reset email failed", {
        userId: String(user._id),
        email: normalizedEmail,
        error: error?.message || String(error),
      });
    }

    return res.json({ message: successMessage });
  } catch (error) {
    return res.status(500).json({
      message: "Error sending password reset email",
      error: error.message,
    });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const rawToken = String(req.body?.token || "").trim();
    const password = String(req.body?.password || "");

    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    const user = await User.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({
        message: "This password reset link is invalid or has expired.",
      });
    }

    user.password = password;
    user.passwordResetTokenHash = undefined;
    user.passwordResetExpiresAt = undefined;
    user.passwordResetRequestedAt = undefined;
    await user.save();

    const token = generateToken(user);

    return res.json({
      message: "Password reset successful",
      token,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Error resetting password",
      error: error.message,
    });
  }
};
