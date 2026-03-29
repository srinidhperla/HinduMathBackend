const Product = require("../models/Product");
const { DEFAULT_WEIGHT_MULTIPLIERS } = require("../config/constants");
const imageStorage = require("../services/cloudinaryStorage");
const { clearPublicApiCache } = require("../services/cacheStore");
const { emitAdminDataUpdated } = require("../services/orderEvents");
const logger = require("../utils/logger");

const CLOUDINARY_DELIVERY_TRANSFORMS = "f_auto,q_auto,w_800";

const optimizeCloudinaryImageUrl = (imageUrl) => {
  const source = String(imageUrl || "").trim();
  if (!/^https?:\/\/res\.cloudinary\.com\//i.test(source)) {
    return source;
  }

  try {
    const parsed = new URL(source);
    const marker = "/image/upload/";
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex < 0) {
      return source;
    }

    const before = parsed.pathname.slice(0, markerIndex + marker.length);
    const after = parsed.pathname.slice(markerIndex + marker.length);
    if (
      after.startsWith(`${CLOUDINARY_DELIVERY_TRANSFORMS}/`) ||
      (after.includes("f_auto") &&
        after.includes("q_auto") &&
        after.includes("w_800"))
    ) {
      return source;
    }

    parsed.pathname = `${before}${CLOUDINARY_DELIVERY_TRANSFORMS}/${after.replace(/^\/+/, "")}`;
    return parsed.toString();
  } catch (_) {
    return source;
  }
};

const normalizeProductImagesForResponse = (product) => {
  if (!product) {
    return product;
  }

  const base = typeof product.toObject === "function" ? product.toObject() : product;
  const normalizedImages = Array.isArray(base.images)
    ? base.images.map((image) => optimizeCloudinaryImageUrl(image))
    : [];
  const normalizedImage = optimizeCloudinaryImageUrl(
    base.image || normalizedImages[0] || "",
  );

  return {
    ...base,
    image: normalizedImage,
    images: normalizedImages.length
      ? normalizedImages
      : [normalizedImage].filter(Boolean),
  };
};

const saveImageFile = async (file) => {
  if (!file) {
    return null;
  }

  const extension = (file.originalname.match(/\.[^.]+$/) || [".jpg"])[0];
  const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
  const { url } = await imageStorage.uploadFile(
    file.buffer,
    fileName,
    file.mimetype,
  );
  return url;
};

const deleteImageFile = async (imageUrl) => {
  const fileId = imageStorage.extractFileId(imageUrl);
  if (fileId) {
    await imageStorage.deleteFile(fileId);
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
    displayOrder: Number.isFinite(Number(body.displayOrder))
      ? Math.max(0, Number(body.displayOrder))
      : undefined,
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

const getNextDisplayOrder = async (category) => {
  const latestProduct = await Product.findOne({ category })
    .sort({ displayOrder: -1, createdAt: -1 })
    .select("displayOrder")
    .lean();

  return Math.max(0, Number(latestProduct?.displayOrder) || 0) + 1;
};

const invalidatePublicCache = async (context = {}) => {
  try {
    await clearPublicApiCache();
  } catch (error) {
    logger.warn("Failed to clear public API cache after product mutation", {
      error: error?.message || String(error),
      ...context,
    });
  }
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
      sortBy,
      sortOrder = "asc",
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
    const normalizedSortBy = String(sortBy || "").trim();
    const normalizedSortOrder = sortOrder === "desc" ? -1 : 1;
    const sort =
      normalizedSortBy.length > 0
        ? { [normalizedSortBy]: normalizedSortOrder }
        : { category: 1, displayOrder: 1, name: 1, createdAt: -1 };

    const products = await Product.find(query).sort(sort);

    res.json(products.map((product) => normalizeProductImagesForResponse(product)));
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching products", error: error.message });
  }
};

// Get single product
exports.getProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json(normalizeProductImagesForResponse(product));
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
    res.status(201).json(normalizeProductImagesForResponse(product));
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
    res.json(normalizeProductImagesForResponse(product));
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

    await invalidatePublicCache({
      action: "updateProductInventory",
      productId: product?._id?.toString(),
    });
    emitAdminDataUpdated("inventory", {
      action: "updated",
      productId: product?._id?.toString(),
    });
    res.json(normalizeProductImagesForResponse(product));
  } catch (error) {
    res.status(500).json({
      message: "Error updating product inventory",
      error: error.message,
    });
  }
};

exports.updateProductDisplayOrder = async (req, res) => {
  try {
    const { category, productIds } = req.body || {};
    const normalizedCategory = String(category || "")
      .trim()
      .toLowerCase();

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
      products: updatedProducts.map((product) =>
        normalizeProductImagesForResponse(product),
      ),
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

    await invalidatePublicCache({
      action: "deleteProduct",
      productId: req.params.id,
    });
    emitAdminDataUpdated("products", {
      action: "deleted",
      productId: req.params.id,
    });
    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting product", error: error.message });
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
    await invalidatePublicCache({
      action: "renameCategory",
      oldName,
      newName: trimmed,
    });
    emitAdminDataUpdated("products", {
      action: "category-renamed",
      oldName,
      newName: trimmed,
    });
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
    await invalidatePublicCache({
      action: "deleteCategory",
      name,
    });
    emitAdminDataUpdated("products", {
      action: "category-deleted",
      name,
    });
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
