const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Generate JWT Token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
};

// Register new user
exports.register = async (req, res) => {
  try {
    const { name, email, password, phone, address } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "Email already registered" });
    }

    // Create new user
    const user = new User({
      name,
      email,
      password,
      phone,
      address,
    });

    await user.save();

    // Generate token
    const token = generateToken(user._id);

    res.status(201).json({
      message: "User registered successfully",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        address: user.address,
        savedAddresses: user.savedAddresses,
      },
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

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Generate token
    const token = generateToken(user._id);

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        address: user.address,
        savedAddresses: user.savedAddresses,
      },
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
    const email = String(payload?.email || "")
      .trim()
      .toLowerCase();
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

    const authToken = generateToken(user._id);

    res.json({
      message: "Login successful",
      token: authToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        address: user.address,
        savedAddresses: user.savedAddresses,
      },
    });
  } catch (error) {
    res.status(401).json({
      message: "Google authentication failed",
      error: error.message,
    });
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
