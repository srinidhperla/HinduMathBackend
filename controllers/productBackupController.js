const Product = require("../models/Product");
const { emitAdminDataUpdated } = require("../services/orderEvents");
const {
  streamProductBackupZip,
  restoreProductImagesFromZip,
} = require("../services/productBackupService");
const { invalidatePublicCache } = require("../services/siteContentService");

exports.exportProductImages = async (req, res) => {
  try {
    const products = await Product.find({}).sort({ category: 1, name: 1 }).lean();
    await streamProductBackupZip(res, products);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        message: "Error exporting product images",
        error: error.message,
      });
    } else {
      res.end();
    }
  }
};

exports.importProductImages = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No backup zip file was uploaded" });
    }

    const result = await restoreProductImagesFromZip(req.file.buffer);

    if (result.updated.length > 0) {
      await invalidatePublicCache({ action: "restoreProductImages" });
      emitAdminDataUpdated("products", { action: "product-images-restored" });
    }

    return res.json({
      message: `Restored ${result.updated.length} image(s). ${result.skipped.length} file(s) skipped.`,
      updated: result.updated,
      skipped: result.skipped,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Error restoring product images",
      error: error.message,
    });
  }
};
