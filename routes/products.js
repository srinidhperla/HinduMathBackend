const express = require("express");
const router = express.Router();
const upload = require("../middleware/upload");
const { auth, isAdmin } = require("../middleware/auth");
const {
  mediumOrderWriteLimiter,
  standardReadLimiter,
} = require("../middleware/rateLimiters");
const {
  buildStableQueryKey,
  cacheResponse,
} = require("../middleware/responseCache");
const {
  validateCreateProduct,
  validateUpdateProduct,
  validateInventoryUpdate,
} = require("../validators/productValidator");
const {
  getAllProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
} = require("../controllers/productController");
const {
  updateProductInventory,
  updateProductDisplayOrder,
} = require("../controllers/productInventoryController");
const {
  renameCategory,
  deleteCategory,
} = require("../controllers/productCategoryController");

// Public routes
router.get(
  "/",
  standardReadLimiter,
  cacheResponse({
    key: (req) => {
      const queryKey = buildStableQueryKey(req.query);
      return queryKey ? `products?${queryKey}` : "products";
    },
    ttlSeconds: 300,
  }),
  getAllProducts,
);
router.get("/:id", standardReadLimiter, getProduct);

// Admin routes
router.put(
  "/display-order",
  auth,
  isAdmin,
  mediumOrderWriteLimiter,
  updateProductDisplayOrder,
);
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
