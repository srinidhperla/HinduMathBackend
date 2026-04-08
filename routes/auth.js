const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const {
  strictAuthLimiter,
  accountLockoutMiddleware,
} = require("../middleware/rateLimiters");
const {
  validateRegister,
  validateLogin,
  validateGoogleLogin,
  validateForgotPassword,
  validateResetPassword,
  validateProfileUpdate,
} = require("../validators/authValidator");
const {
  register,
  login,
  googleLogin,
  forgotPassword,
  resetPassword,
  getMe,
  getProfile,
  updateProfile,
} = require("../controllers/authController");

// Public routes
router.post("/register", strictAuthLimiter, validateRegister, register);
router.post(
  "/login",
  strictAuthLimiter,
  accountLockoutMiddleware,
  validateLogin,
  login,
);
router.post(
  "/forgot-password",
  strictAuthLimiter,
  validateForgotPassword,
  forgotPassword,
);
router.post(
  "/reset-password",
  strictAuthLimiter,
  validateResetPassword,
  resetPassword,
);
router.post(
  "/google-login",
  strictAuthLimiter,
  validateGoogleLogin,
  googleLogin,
);

// Protected routes
router.get("/me", auth, getMe);
router.get("/profile", auth, getProfile);
router.put("/profile", auth, validateProfileUpdate, updateProfile);

module.exports = router;
