const Product = require("../models/Product");
const {
  emitAdminDataUpdated,
} = require("../services/orderEvents");
const {
  invalidatePublicCache,
} = require("../services/productWorkflowService");

const normalizeCategoryName = (value = "") =>
  String(value || "").trim().toLowerCase();

const renameCategory = async (req, res) => {
  try {
    const { oldName, newName } = req.body;
    const fromCategory = normalizeCategoryName(oldName);
    const toCategory = normalizeCategoryName(newName);

    if (!fromCategory || !toCategory) {
      return res.status(400).json({ message: "oldName and newName are required" });
    }

    const result = await Product.updateMany(
      { category: fromCategory },
      { $set: { category: toCategory } },
    );

    await invalidatePublicCache({
      action: "renameCategory",
      oldName: fromCategory,
      newName: toCategory,
    });
    emitAdminDataUpdated("products", {
      action: "category-renamed",
      oldName: fromCategory,
      newName: toCategory,
    });

    return res.json({
      message: "Category renamed",
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error renaming category", error: error.message });
  }
};

const deleteCategory = async (req, res) => {
  try {
    const categoryName = normalizeCategoryName(req.params.name);
    if (!categoryName) {
      return res.status(400).json({ message: "Category name is required" });
    }

    const result = await Product.updateMany(
      { category: categoryName },
      { $set: { category: "cakes" } },
    );

    await invalidatePublicCache({
      action: "deleteCategory",
      name: categoryName,
    });
    emitAdminDataUpdated("products", {
      action: "category-deleted",
      name: categoryName,
    });

    return res.json({
      message: "Category deleted, products moved to cakes",
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error deleting category", error: error.message });
  }
};

module.exports = {
  renameCategory,
  deleteCategory,
};

