const jwt = require("jsonwebtoken");
const User = require("../models/User");

const auth = async (req, res, next) => {
  try {
    const token = req.header("Authorization")?.replace("Bearer ", "");

    if (!token) {
      throw new Error();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findOne({ _id: decoded.id }).select("-password");

    if (!user) {
      throw new Error();
    }

    if (decoded.role !== user.role) {
      throw new Error();
    }

    req.user = {
      _id: user._id,
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: decoded.role,
      phone: user.phone,
      address: user.address,
      savedAddresses: user.savedAddresses,
    };
    req.token = token;
    next();
  } catch (error) {
    res.status(401).json({ message: "Please authenticate." });
  }
};

const isAdmin = async (req, res, next) => {
  try {
    return requireRole("admin")(req, res, next);
  } catch (error) {
    res.status(500).json({ message: "Server error." });
  }
};

const requireRole =
  (...allowedRoles) =>
  async (req, res, next) => {
    try {
      if (!req.user || !allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
          message: `Access denied. Allowed roles: ${allowedRoles.join(", ")}.`,
        });
      }

      return next();
    } catch (error) {
      return res.status(500).json({ message: "Server error." });
    }
  };

const isDelivery = requireRole("delivery");

module.exports = { auth, isAdmin, isDelivery, requireRole };
