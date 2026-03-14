const express = require("express");
const router = express.Router();
const upload = require("../middleware/upload");
const { auth, isAdmin } = require("../middleware/auth");
const {
  mediumOrderWriteLimiter,
  standardReadLimiter,
} = require("../middleware/rateLimiters");
const {
  validateCreateProduct,
  validateUpdateProduct,
  validateInventoryUpdate,
  validateAddReview,
} = require("../src/validators/productValidator");
const {
  getAllProducts,
  getProduct,
  createProduct,
  updateProduct,
  updateProductInventory,
  deleteProduct,
  addReview,
  renameCategory,
  deleteCategory,
} = require("../controllers/productController");

// Public routes
router.get("/", standardReadLimiter, getAllProducts);
router.get("/:id", standardReadLimiter, getProduct);

// Protected routes (require authentication)
router.post(
  "/:id/reviews",
  auth,
  mediumOrderWriteLimiter,
  validateAddReview,
  addReview,
);

// Admin routes
router.put(
  "/batch/category",
  auth,
  isAdmin,
  mediumOrderWriteLimiter,
  renameCategory,
);
router.delete(
  "/batch/category/:name",
  auth,
  isAdmin,
  mediumOrderWriteLimiter,
  deleteCategory,
);
router.post(
  "/",
  auth,
  isAdmin,
  mediumOrderWriteLimiter,
  upload.array("images", 8),
  validateCreateProduct,
  createProduct,
);
router.put(
  "/:id",
  auth,
  isAdmin,
  mediumOrderWriteLimiter,
  upload.array("images", 8),
  validateUpdateProduct,
  updateProduct,
);
router.patch(
  "/:id/inventory",
  auth,
  isAdmin,
  mediumOrderWriteLimiter,
  validateInventoryUpdate,
  updateProductInventory,
);
router.delete("/:id", auth, isAdmin, mediumOrderWriteLimiter, deleteProduct);

module.exports = router;
