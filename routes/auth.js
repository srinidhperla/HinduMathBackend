const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const { strictAuthLimiter } = require("../middleware/rateLimiters");
const {
  validateRegister,
  validateLogin,
  validateGoogleLogin,
  validateProfileUpdate,
} = require("../src/validators/authValidator");
const {
  register,
  login,
  googleLogin,
  getProfile,
  updateProfile,
} = require("../controllers/authController");

// Public routes
router.post("/register", strictAuthLimiter, validateRegister, register);
router.post("/login", strictAuthLimiter, validateLogin, login);
router.post(
  "/google-login",
  strictAuthLimiter,
  validateGoogleLogin,
  googleLogin,
);

// Protected routes
router.get("/profile", auth, getProfile);
router.put("/profile", auth, validateProfileUpdate, updateProfile);

module.exports = router;
