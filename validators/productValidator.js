const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const validateCreateProduct = (req, res, next) => {
  const { name, description, price, category } = req.body || {};

  if (!isNonEmptyString(name)) {
    return res.status(400).json({ message: "Product name is required" });
  }

  if (!isNonEmptyString(description)) {
    return res.status(400).json({ message: "Product description is required" });
  }

  if (!isNonEmptyString(category)) {
    return res.status(400).json({ message: "Product category is required" });
  }

  if (!Number.isFinite(Number(price)) || Number(price) < 0) {
    return res.status(400).json({ message: "Product price must be valid" });
  }

  return next();
};

const validateUpdateProduct = (req, res, next) => {
  const { name, description, price, category } = req.body || {};

  if (name !== undefined && !isNonEmptyString(name)) {
    return res.status(400).json({ message: "Product name cannot be empty" });
  }

  if (description !== undefined && !isNonEmptyString(description)) {
    return res
      .status(400)
      .json({ message: "Product description cannot be empty" });
  }

  if (category !== undefined && !isNonEmptyString(category)) {
    return res
      .status(400)
      .json({ message: "Product category cannot be empty" });
  }

  if (
    price !== undefined &&
    (!Number.isFinite(Number(price)) || Number(price) < 0)
  ) {
    return res.status(400).json({ message: "Product price must be valid" });
  }

  return next();
};

const validateInventoryUpdate = (req, res, next) => {
  const { flavorOptions, weightOptions } = req.body || {};

  if (flavorOptions !== undefined && !Array.isArray(flavorOptions)) {
    return res.status(400).json({ message: "flavorOptions must be an array" });
  }

  if (weightOptions !== undefined && !Array.isArray(weightOptions)) {
    return res.status(400).json({ message: "weightOptions must be an array" });
  }

  return next();
};

const validateAddReview = (req, res, next) => {
  const { rating, comment } = req.body || {};

  if (
    !Number.isFinite(Number(rating)) ||
    Number(rating) < 1 ||
    Number(rating) > 5
  ) {
    return res.status(400).json({ message: "Rating must be between 1 and 5" });
  }

  if (comment !== undefined && typeof comment !== "string") {
    return res.status(400).json({ message: "Comment must be text" });
  }

  return next();
};

module.exports = {
  validateCreateProduct,
  validateUpdateProduct,
  validateInventoryUpdate,
  validateAddReview,
};
