const Product = require("../models/Product");
const { emitAdminDataUpdated } = require("../services/orderEvents");
const {
  normalizeProductImagesForResponse,
  normalizeProductPayload,
  parseObjectArrayField,
  parseArrayField,
  saveImageFiles,
  deleteImageFiles,
  buildOrderedImages,
  getNextDisplayOrder,
  invalidatePublicCache,
} = require("../services/productWorkflowService");

const getAllProducts = async (req, res) => {
  try {
    const {
      category,
      occasion,
      minPrice,
      maxPrice,
      search,
      sortBy,
      sortOrder = "asc",
    } = req.query;
    const query = {};

    if (category) query.category = category;
    if (occasion) query.occasion = occasion;
    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = Number(minPrice);
      if (maxPrice) query.price.$lte = Number(maxPrice);
    }
    if (search) query.$text = { $search: search };

    const normalizedSortBy = String(sortBy || "").trim();
    const normalizedSortOrder = sortOrder === "desc" ? -1 : 1;
    const sort =
      normalizedSortBy.length > 0
        ? { [normalizedSortBy]: normalizedSortOrder }
        : { category: 1, displayOrder: 1, name: 1, createdAt: -1 };

    const products = await Product.find(query).sort(sort);
    return res.json(
      products.map((product) => normalizeProductImagesForResponse(product)),
    );
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error fetching products", error: error.message });
  }
};

const getProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }
    return res.json(normalizeProductImagesForResponse(product));
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error fetching product", error: error.message });
  }
};

const createProduct = async (req, res) => {
  try {
    const payload = normalizeProductPayload(req.body);
    const imageOrder = parseObjectArrayField(req.body.imageOrder);
    const newImageIds = parseArrayField(req.body.newImageIds);

    if (!req.files?.length) {
      return res
        .status(400)
        .json({ message: "At least one product image is required" });
    }

    const savedNewImages = await saveImageFiles(req.files);
    const newImageMap = new Map(
      savedNewImages.map((imagePath, index) => [
        newImageIds[index] || `new-${index}`,
        imagePath,
      ]),
    );

    payload.images = buildOrderedImages({
      imageOrder,
      existingImages: [],
      newImageMap,
    });
    payload.image = payload.images[0];
    payload.displayOrder =
      payload.displayOrder ?? (await getNextDisplayOrder(payload.category));

    const product = new Product(payload);
    await product.save();
    await invalidatePublicCache({
      action: "createProduct",
      productId: product._id?.toString(),
    });
    emitAdminDataUpdated("products", {
      action: "created",
      productId: product._id?.toString(),
    });

    return res.status(201).json(normalizeProductImagesForResponse(product));
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error creating product", error: error.message });
  }
};

const updateProduct = async (req, res) => {
  try {
    const existingProduct = await Product.findById(req.params.id);
    if (!existingProduct) {
      return res.status(404).json({ message: "Product not found" });
    }

    const payload = normalizeProductPayload(req.body);
    const imageOrder = parseObjectArrayField(req.body.imageOrder);
    const newImageIds = parseArrayField(req.body.newImageIds);
    const existingImages =
      Array.isArray(existingProduct.images) && existingProduct.images.length
        ? existingProduct.images
        : existingProduct.image
          ? [existingProduct.image]
          : [];

    const hasNewImageUpload = Array.isArray(req.files) && req.files.length > 0;
    const keptExistingImages = payload.images.length
      ? payload.images
      : existingImages;
    let nextImages = keptExistingImages;

    if (hasNewImageUpload) {
      const savedNewImages = await saveImageFiles(req.files);
      const newImageMap = new Map(
        savedNewImages.map((imagePath, index) => [
          newImageIds[index] || `new-${index}`,
          imagePath,
        ]),
      );

      nextImages = buildOrderedImages({
        imageOrder,
        existingImages: keptExistingImages,
        newImageMap,
      });
    } else if (imageOrder.length > 0) {
      nextImages = buildOrderedImages({
        imageOrder,
        existingImages: keptExistingImages,
        newImageMap: new Map(),
      });
    }

    // Keep existing Cloudinary assets unless this edit uploaded a replacement image.
    const removedImages = existingImages.filter(
      (imagePath) =>
        !nextImages.includes(imagePath) &&
        existingProduct.images?.includes(imagePath),
    );
    payload.images = nextImages;
    if (hasNewImageUpload && removedImages.length > 0) {
      await deleteImageFiles(removedImages);
    }

    payload.image = payload.images[0] || existingProduct.image;
    if (payload.displayOrder === undefined) {
      delete payload.displayOrder;
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: payload },
      { new: true, runValidators: true },
    );

    await invalidatePublicCache({
      action: "updateProduct",
      productId: product?._id?.toString(),
    });
    emitAdminDataUpdated("products", {
      action: "updated",
      productId: product?._id?.toString(),
    });

    return res.json(normalizeProductImagesForResponse(product));
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error updating product", error: error.message });
  }
};

const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    await deleteImageFiles(
      Array.isArray(product.images) && product.images.length
        ? product.images
        : [product.image].filter(Boolean),
    );

    await invalidatePublicCache({
      action: "deleteProduct",
      productId: req.params.id,
    });
    emitAdminDataUpdated("products", {
      action: "deleted",
      productId: req.params.id,
    });
    return res.json({ message: "Product deleted successfully" });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error deleting product", error: error.message });
  }
};

module.exports = {
  getAllProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
};
