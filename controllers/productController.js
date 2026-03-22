const Product = require("../models/Product");
const { DEFAULT_WEIGHT_MULTIPLIERS } = require("../config/constants");
const appwrite = require("../services/appwriteStorage");

const saveImageFile = async (file) => {
  if (!file) {
    return null;
  }

  const extension = (file.originalname.match(/\.[^.]+$/) || [".jpg"])[0];
  const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
  const { url } = await appwrite.uploadFile(
    file.buffer,
    fileName,
    file.mimetype,
  );
  return url;
};

const deleteImageFile = async (imageUrl) => {
  const fileId = appwrite.extractFileId(imageUrl);
  if (fileId) {
    await appwrite.deleteFile(fileId);
  }
};

const saveImageFiles = async (files) => {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  const savedImages = await Promise.all(
    files.map((file) => saveImageFile(file)),
  );

  return savedImages.filter(Boolean);
};

const deleteImageFiles = async (imagePaths = []) => {
  await Promise.all(imagePaths.map((imagePath) => deleteImageFile(imagePath)));
};

const parseArrayField = (value) => {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => item.toString().trim()).filter(Boolean);
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => item.toString().trim()).filter(Boolean);
    }
  } catch (error) {
    return value
      .toString()
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
};

const parseBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["true", "1", "yes", "on"].includes(value.toString().toLowerCase());
};

const parseObjectArrayField = (value) => {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
};

const parseObjectField = (value) => {
  if (!value) {
    return {};
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (error) {
    return {};
  }
};

const normalizePortionType = (value, fallback = "weight") => {
  const normalized = String(value || fallback).toLowerCase();
  return ["weight", "size", "pieces"].includes(normalized)
    ? normalized
    : "weight";
};

const normalizeFlavorOptions = (body) => {
  const flavorOptions = parseObjectArrayField(body.flavorOptions)
    .map((option) => ({
      name: option.name?.toString().trim(),
      isAvailable: parseBoolean(option.isAvailable, true),
    }))
    .filter((option) => option.name);

  if (flavorOptions.length > 0) {
    return flavorOptions;
  }

  return parseArrayField(body.flavors).map((flavor) => ({
    name: flavor,
    isAvailable: true,
  }));
};

const normalizeWeightOptions = (body) => {
  const weightOptions = parseObjectArrayField(body.weightOptions)
    .map((option) => {
      const label = option.label?.toString().trim();
      const multiplier = Number(option.multiplier);

      return {
        label,
        multiplier:
          Number.isFinite(multiplier) && multiplier > 0
            ? multiplier
            : DEFAULT_WEIGHT_MULTIPLIERS[label] || 1,
        isAvailable: parseBoolean(option.isAvailable, true),
      };
    })
    .filter((option) => option.label);

  if (weightOptions.length > 0) {
    return weightOptions;
  }

  return parseArrayField(body.sizes).map((label) => ({
    label,
    multiplier: DEFAULT_WEIGHT_MULTIPLIERS[label] || 1,
    isAvailable: true,
  }));
};

const normalizeAddOnOptions = (body, fallback = []) => {
  const source =
    body?.addOns !== undefined ? parseObjectArrayField(body.addOns) : fallback;

  return source
    .map((option) => {
      const name = String(option?.name || "").trim();
      const description = String(option?.description || "").trim();
      const image = String(option?.image || "").trim();
      const price = Number(option?.price);

      if (!name || !Number.isFinite(price) || price < 0) {
        return null;
      }

      return {
        name,
        description,
        image,
        price,
        isAvailable: parseBoolean(option?.isAvailable, true),
      };
    })
    .filter(Boolean);
};

const normalizeFlavorWeightAvailability = (
  rawValue,
  flavorOptions,
  weightOptions,
  fallback = {},
) => {
  const base =
    rawValue && typeof rawValue === "object"
      ? rawValue
      : fallback && typeof fallback === "object"
        ? fallback
        : {};

  const matrix = {};

  // Preserve typed keys (egg::*, eggless::*) for per-type availability
  const getKeys = (obj) => {
    if (obj instanceof Map) return Array.from(obj.keys());
    if (obj && typeof obj === "object") return Object.keys(obj);
    return [];
  };
  const allKeys = new Set([...getKeys(base), ...getKeys(fallback)]);
  const normalizeStatus = (rawStatus) => {
    if (rawStatus === null) return null;
    if (rawStatus === false) return false;
    return true;
  };

  const lookupStatus = (row, label) => {
    if (label in row) return row[label];
    const lower = label.toLowerCase();
    if (lower in row) return row[lower];
    return undefined;
  };

  allKeys.forEach((key) => {
    if (!key.includes("::")) return;
    const sourceRow =
      base[key] ||
      base?.get?.(key) ||
      fallback[key] ||
      fallback?.get?.(key) ||
      {};
    const normalizedRow = {};
    weightOptions.forEach((weightOption) => {
      const rawStatus = lookupStatus(sourceRow, weightOption.label);
      normalizedRow[weightOption.label] = normalizeStatus(rawStatus);
    });
    matrix[key] = normalizedRow;
  });

  // Build plain flavor keys by aggregating typed keys.
  // A weight is available for a flavor if available in ANY egg type.
  const effectiveFlavors =
    flavorOptions.length > 0
      ? flavorOptions
      : [{ name: "Cake", isAvailable: true }];
  effectiveFlavors.forEach((flavorOption) => {
    const flavorName = flavorOption.name;
    const typedKeys = ["egg", "eggless"]
      .map((t) => `${t}::${flavorName}`)
      .filter((k) => matrix[k]);

    const normalizedRow = {};
    weightOptions.forEach((weightOption) => {
      const wl = weightOption.label;
      if (typedKeys.length > 0) {
        // Aggregate: available if ANY typed key has it available
        const statuses = typedKeys.map((k) => matrix[k][wl]);
        if (statuses.some((s) => s === true)) normalizedRow[wl] = true;
        else if (statuses.some((s) => s === false)) normalizedRow[wl] = false;
        else normalizedRow[wl] = null;
      } else {
        // Fallback to plain key source
        const sourceRow =
          base[flavorName] ||
          base[flavorName.toLowerCase()] ||
          base?.get?.(flavorName) ||
          base?.get?.(flavorName.toLowerCase()) ||
          {};
        normalizedRow[wl] = normalizeStatus(lookupStatus(sourceRow, wl));
      }
    });

    matrix[flavorName] = normalizedRow;
  });

  return matrix;
};

const normalizeVariantPrices = (rawValue, weightOptions, fallback = {}) => {
  const base =
    rawValue && typeof rawValue === "object"
      ? rawValue
      : fallback && typeof fallback === "object"
        ? fallback
        : {};

  const matrix = {};
  const getKeys = (obj) => {
    if (obj instanceof Map) return Array.from(obj.keys());
    if (obj && typeof obj === "object") return Object.keys(obj);
    return [];
  };

  const allKeys = new Set([...getKeys(base), ...getKeys(fallback)]);

  const readPrice = (row, label) => {
    const direct = row?.[label];
    const lower = row?.[String(label).toLowerCase()];
    const value = direct ?? lower;
    const numeric = Number(value?.price ?? value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
  };

  allKeys.forEach((key) => {
    if (!String(key).includes("::")) return;

    const sourceRow =
      base[key] ||
      base?.get?.(key) ||
      fallback[key] ||
      fallback?.get?.(key) ||
      {};

    const normalizedRow = {};
    weightOptions.forEach((weightOption) => {
      normalizedRow[weightOption.label] = readPrice(
        sourceRow,
        weightOption.label,
      );
    });

    matrix[key] = normalizedRow;
  });

  return matrix;
};

const getMinimumVariantPrice = (
  variantPrices,
  flavorWeightAvailability = {},
  axes = {},
) => {
  if (!variantPrices || typeof variantPrices !== "object") {
    return null;
  }

  const getRowEntries = (source) => {
    if (source instanceof Map) {
      return Array.from(source.entries());
    }
    return Object.entries(source || {});
  };

  const findRowByTypedKey = (source, typedKey) => {
    if (!source || typeof source !== "object") return null;
    const direct =
      source?.[typedKey] ||
      source?.get?.(typedKey) ||
      source?.[String(typedKey).toLowerCase()] ||
      source?.get?.(String(typedKey).toLowerCase());
    if (direct && typeof direct === "object") {
      return direct;
    }

    const typedKeyLower = String(typedKey).toLowerCase();
    const entries =
      source instanceof Map
        ? Array.from(source.entries())
        : Object.entries(source || {});
    const matched = entries.find(
      ([key]) => String(key).toLowerCase() === typedKeyLower,
    );
    return matched && typeof matched[1] === "object" ? matched[1] : null;
  };

  const readRowValue = (row, unitLabel) => {
    if (!row || typeof row !== "object") return undefined;

    const label = String(unitLabel || "").trim();
    if (label in row) return row[label];

    const lower = label.toLowerCase();
    if (lower in row) return row[lower];

    const entries = Object.entries(row || {});
    const matched = entries.find(
      ([key]) =>
        String(key || "")
          .trim()
          .toLowerCase() === lower,
    );
    return matched ? matched[1] : undefined;
  };

  const getCellEnabled = (typedKey, unitLabel) => {
    const row = findRowByTypedKey(flavorWeightAvailability, typedKey);

    if (!row || typeof row !== "object") {
      return true;
    }

    const value = readRowValue(row, unitLabel);

    return value !== false && value !== null;
  };

  let minimum = null;
  getRowEntries(variantPrices).forEach(([typedKey, row]) => {
    if (
      axes?.validTypedKeys instanceof Set &&
      axes.validTypedKeys.size > 0 &&
      !axes.validTypedKeys.has(typedKey) &&
      !axes.validTypedKeys.has(String(typedKey).toLowerCase())
    ) {
      return;
    }

    if (!row || typeof row !== "object") return;
    Object.entries(row).forEach(([unitLabel, value]) => {
      const normalizedLabel = String(unitLabel || "").trim();
      if (
        axes?.validLabels instanceof Set &&
        axes.validLabels.size > 0 &&
        !axes.validLabels.has(normalizedLabel) &&
        !axes.validLabels.has(normalizedLabel.toLowerCase())
      ) {
        return;
      }
      if (!getCellEnabled(typedKey, unitLabel)) return;
      const numeric = Number(value?.price ?? value);
      if (!Number.isFinite(numeric) || numeric <= 0) return;
      minimum = minimum === null ? numeric : Math.min(minimum, numeric);
    });
  });

  return minimum;
};

const getVariantAxes = ({
  flavorOptions = [],
  weightOptions = [],
  isEgg = true,
  isEggless = false,
}) => {
  const validLabels = new Set();
  weightOptions
    .map((option) => option.label)
    .filter(Boolean)
    .forEach((label) => {
      validLabels.add(String(label));
      validLabels.add(String(label).toLowerCase());
    });
  const flavorNames =
    flavorOptions.length > 0
      ? flavorOptions.map((option) => option.name).filter(Boolean)
      : ["Cake"];
  const eggTypes = [isEgg ? "egg" : null, isEggless ? "eggless" : null].filter(
    Boolean,
  );
  const validTypedKeys = new Set();

  eggTypes.forEach((eggType) => {
    flavorNames.forEach((flavorName) => {
      const typedKey = `${eggType}::${flavorName}`;
      validTypedKeys.add(typedKey);
      validTypedKeys.add(typedKey.toLowerCase());
    });
  });

  return { validLabels, validTypedKeys };
};

const normalizeProductPayload = (body) => {
  const flavorOptions = normalizeFlavorOptions(body);
  const weightOptions = normalizeWeightOptions(body);
  const existingImages = parseArrayField(body.existingImages);
  const flavorWeightAvailability = normalizeFlavorWeightAvailability(
    parseObjectField(body.flavorWeightAvailability),
    flavorOptions,
    weightOptions,
  );
  const variantPrices = normalizeVariantPrices(
    parseObjectField(body.variantPrices),
    weightOptions,
  );
  const isEgg = parseBoolean(body.isEgg, true);
  const isEggless = parseBoolean(body.isEggless, false);
  const axes = getVariantAxes({
    flavorOptions,
    weightOptions,
    isEgg,
    isEggless,
  });
  const minimumVariantPrice = getMinimumVariantPrice(
    variantPrices,
    flavorWeightAvailability,
    axes,
  );
  const hasTypedVariantRows = Object.keys(variantPrices || {}).length > 0;
  const basePrice = Number(body.price);
  const normalizedBasePrice =
    minimumVariantPrice !== null
      ? minimumVariantPrice
      : hasTypedVariantRows
        ? 0
        : Number.isFinite(basePrice) && basePrice > 0
          ? basePrice
          : 0;

  return {
    name: body.name?.trim(),
    description: body.description?.trim(),
    price: normalizedBasePrice,
    category: body.category?.trim().toLowerCase(),
    portionType: normalizePortionType(body.portionType),
    isAvailable: parseBoolean(body.isAvailable, true),
    isAddon: parseBoolean(body.isAddon, false),
    isEgg,
    isEggless,
    isFeatured: parseBoolean(body.isFeatured, false),
    addOns: normalizeAddOnOptions(body),
    flavors: flavorOptions.map((option) => option.name),
    flavorOptions,
    sizes: weightOptions.map((option) => option.label),
    weightOptions,
    flavorWeightAvailability,
    variantPrices,
    images: existingImages,
  };
};

const normalizeInventoryPayload = (body, existingProduct) => {
  const flavorOptions =
    body.flavorOptions === undefined
      ? normalizeFlavorOptions(existingProduct)
      : parseObjectArrayField(body.flavorOptions)
          .map((option) => ({
            name: option.name?.toString().trim(),
            isAvailable: parseBoolean(option.isAvailable, true),
          }))
          .filter((option) => option.name);

  const weightOptions =
    body.weightOptions === undefined
      ? normalizeWeightOptions(existingProduct)
      : parseObjectArrayField(body.weightOptions)
          .map((option) => {
            const label = option.label?.toString().trim();
            const multiplier = Number(option.multiplier);

            return {
              label,
              multiplier:
                Number.isFinite(multiplier) && multiplier > 0
                  ? multiplier
                  : DEFAULT_WEIGHT_MULTIPLIERS[label] || 1,
              isAvailable: parseBoolean(option.isAvailable, true),
            };
          })
          .filter((option) => option.label);

  const variantPrices = normalizeVariantPrices(
    parseObjectField(body.variantPrices),
    weightOptions,
    existingProduct.variantPrices || {},
  );
  const isEgg = parseBoolean(body.isEgg, existingProduct.isEgg !== false);
  const isEggless = parseBoolean(
    body.isEggless,
    existingProduct.isEggless === true,
  );
  const normalizedFlavorWeightAvailability = normalizeFlavorWeightAvailability(
    parseObjectField(body.flavorWeightAvailability),
    flavorOptions,
    weightOptions,
    existingProduct.flavorWeightAvailability || {},
  );
  const axes = getVariantAxes({
    flavorOptions,
    weightOptions,
    isEgg,
    isEggless,
  });
  const minimumVariantPrice = getMinimumVariantPrice(
    variantPrices,
    normalizedFlavorWeightAvailability,
    axes,
  );
  const hasTypedVariantRows = Object.keys(variantPrices || {}).length > 0;

  return {
    isAvailable: parseBoolean(
      body.isAvailable,
      existingProduct.isAvailable !== false,
    ),
    isAddon: parseBoolean(body.isAddon, existingProduct.isAddon === true),
    portionType: normalizePortionType(
      body.portionType,
      existingProduct.portionType,
    ),
    isEgg,
    isEggless,
    addOns: normalizeAddOnOptions(body, existingProduct.addOns || []),
    flavors: flavorOptions.map((option) => option.name),
    flavorOptions,
    sizes: weightOptions.map((option) => option.label),
    weightOptions,
    flavorWeightAvailability: normalizedFlavorWeightAvailability,
    variantPrices,
    price:
      minimumVariantPrice !== null
        ? minimumVariantPrice
        : hasTypedVariantRows
          ? 0
          : Number(existingProduct.price) || 0,
  };
};

const buildOrderedImages = ({ imageOrder, existingImages, newImageMap }) => {
  if (!Array.isArray(imageOrder) || imageOrder.length === 0) {
    return [...existingImages, ...Array.from(newImageMap.values())].filter(
      Boolean,
    );
  }

  return imageOrder
    .map((entry) => {
      if (entry?.type === "existing") {
        return existingImages.find((image) => image === entry.value) || null;
      }

      if (entry?.type === "new") {
        return newImageMap.get(entry.value) || null;
      }

      return null;
    })
    .filter(Boolean);
};

// Get all products with optional filtering
exports.getAllProducts = async (req, res) => {
  try {
    const {
      category,
      occasion,
      minPrice,
      maxPrice,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    let query = {};

    // Apply filters
    if (category) query.category = category;
    if (occasion) query.occasion = occasion;
    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = Number(minPrice);
      if (maxPrice) query.price.$lte = Number(maxPrice);
    }
    if (search) {
      query.$text = { $search: search };
    }

    // Apply sorting
    const sort = {};
    sort[sortBy] = sortOrder === "desc" ? -1 : 1;

    const products = await Product.find(query)
      .sort(sort)
      .populate("reviews.user", "name");

    res.json(products);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching products", error: error.message });
  }
};

// Get single product
exports.getProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).populate(
      "reviews.user",
      "name",
    );

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json(product);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching product", error: error.message });
  }
};

// Create new product (admin only)
exports.createProduct = async (req, res) => {
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

    const product = new Product(payload);
    await product.save();
    res.status(201).json(product);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error creating product", error: error.message });
  }
};

// Update product (admin only)
exports.updateProduct = async (req, res) => {
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

    const keptExistingImages = payload.images.length
      ? payload.images
      : existingImages;
    let nextImages = keptExistingImages;

    if (req.files?.length) {
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
    }

    if (!req.files?.length && imageOrder.length > 0) {
      nextImages = buildOrderedImages({
        imageOrder,
        existingImages: keptExistingImages,
        newImageMap: new Map(),
      });
    }

    const removedImages = existingImages.filter(
      (imagePath) => !nextImages.includes(imagePath),
    );

    payload.images = nextImages;
    await deleteImageFiles(removedImages);

    payload.image = payload.images[0] || existingProduct.image;

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: payload },
      { new: true, runValidators: true },
    );

    res.json(product);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error updating product", error: error.message });
  }
};

// Update product inventory (admin only)
exports.updateProductInventory = async (req, res) => {
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

    res.json(product);
  } catch (error) {
    res.status(500).json({
      message: "Error updating product inventory",
      error: error.message,
    });
  }
};

// Delete product (admin only)
exports.deleteProduct = async (req, res) => {
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

    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting product", error: error.message });
  }
};

// Add review to product
exports.addReview = async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Check if user has already reviewed
    const hasReviewed = product.reviews.some(
      (review) => review.user.toString() === req.user._id.toString(),
    );

    if (hasReviewed) {
      return res
        .status(400)
        .json({ message: "You have already reviewed this product" });
    }

    // Add review
    product.reviews.push({
      user: req.user._id,
      rating,
      comment,
    });

    // Update average rating
    const totalRating = product.reviews.reduce(
      (acc, review) => acc + review.rating,
      0,
    );
    product.rating = totalRating / product.reviews.length;

    await product.save();
    await product.populate("reviews.user", "name");
    res.json(product);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error adding review", error: error.message });
  }
};

exports.renameCategory = async (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) {
      return res
        .status(400)
        .json({ message: "oldName and newName are required" });
    }
    const trimmed = newName.trim().toLowerCase();
    if (!trimmed) {
      return res
        .status(400)
        .json({ message: "New category name cannot be empty" });
    }
    const result = await Product.updateMany(
      { category: oldName.trim().toLowerCase() },
      { $set: { category: trimmed } },
    );
    res.json({
      message: "Category renamed",
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error renaming category", error: error.message });
  }
};

exports.deleteCategory = async (req, res) => {
  try {
    const { name } = req.params;
    if (!name) {
      return res.status(400).json({ message: "Category name is required" });
    }
    const result = await Product.updateMany(
      { category: name.trim().toLowerCase() },
      { $set: { category: "cakes" } },
    );
    res.json({
      message: "Category deleted, products moved to cakes",
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting category", error: error.message });
  }
};
