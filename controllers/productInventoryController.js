const Product = require("../models/Product");
const {
  emitAdminDataUpdated,
} = require("../services/orderEvents");
const logger = require("../utils/logger");
const {
  normalizeProductImagesForResponse,
  normalizeInventoryPayload,
  invalidatePublicCache,
} = require("../services/productWorkflowService");

const updateProductInventory = async (req, res) => {
  try {
    const existingProduct = await Product.findById(req.params.id);
    if (!existingProduct) {
      return res.status(404).json({ message: "Product not found" });
    }

    const payload = normalizeInventoryPayload(req.body, existingProduct);
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: payload },
      { new: true, runValidators: true },
    );

    await invalidatePublicCache({
      action: "updateProductInventory",
      productId: product?._id?.toString(),
    });
    emitAdminDataUpdated("inventory", {
      action: "updated",
      productId: product?._id?.toString(),
    });
    return res.json(normalizeProductImagesForResponse(product));
  } catch (error) {
    return res.status(500).json({
      message: "Error updating product inventory",
      error: error.message,
    });
  }
};

const updateProductDisplayOrder = async (req, res) => {
  try {
    const { category, productIds } = req.body || {};
    const normalizedCategory = String(category || "").trim().toLowerCase();

    if (!normalizedCategory || !Array.isArray(productIds) || !productIds.length) {
      return res.status(400).json({
        message: "category and ordered productIds are required",
      });
    }

    const uniqueIds = [...new Set(productIds.map((id) => String(id)))];
    const products = await Product.find({
      _id: { $in: uniqueIds },
      category: normalizedCategory,
    })
      .select("_id category")
      .lean();

    if (products.length !== uniqueIds.length) {
      return res.status(400).json({
        message: "Some products could not be found in the selected category",
      });
    }

    await Promise.all(
      uniqueIds.map((productId, index) =>
        Product.updateOne(
          { _id: productId, category: normalizedCategory },
          { $set: { displayOrder: index + 1 } },
        ),
      ),
    );

    const updatedProducts = await Product.find({ category: normalizedCategory })
      .sort({ displayOrder: 1, name: 1 })
      .lean();

    await invalidatePublicCache({
      action: "updateProductDisplayOrder",
      category: normalizedCategory,
    });
    emitAdminDataUpdated("inventory", {
      action: "display-order-updated",
      category: normalizedCategory,
    });
    return res.json({
      message: "Product order updated successfully",
      category: normalizedCategory,
      products: updatedProducts.map((product) => normalizeProductImagesForResponse(product)),
    });
  } catch (error) {
    logger.error("Failed to update product display order", {
      error: error.message,
      body: req.body,
    });
    return res.status(500).json({
      message: "Error updating product display order",
      error: error.message,
    });
  }
};

module.exports = {
  updateProductInventory,
  updateProductDisplayOrder,
};

