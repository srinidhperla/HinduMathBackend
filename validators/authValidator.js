const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const isValidEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

const isValidPhone = (value) =>
  /^[+]?[0-9\s-]{10,15}$/.test(String(value || "").trim());

const validateRegister = (req, res, next) => {
  const { name, email, password, phone } = req.body || {};

  if (!isNonEmptyString(name)) {
    return res.status(400).json({ message: "Name is required" });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: "Valid email is required" });
  }

  if (!isNonEmptyString(password) || String(password).trim().length < 6) {
    return res
      .status(400)
      .json({ message: "Password must be at least 6 characters" });
  }

  if (!isNonEmptyString(phone)) {
    return res.status(400).json({ message: "Phone number is required" });
  }

  if (!isValidPhone(phone)) {
    return res.status(400).json({ message: "Valid phone number is required" });
  }

  return next();
};

const validateGoogleLogin = (req, res, next) => {
  const { token } = req.body || {};

  if (!isNonEmptyString(token)) {
    return res.status(400).json({ message: "Google token is required" });
  }

  return next();
};

const validateLogin = (req, res, next) => {
  const { email, password } = req.body || {};

  if (!isValidEmail(email) || !isNonEmptyString(password)) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  return next();
};

const validateProfileUpdate = (req, res, next) => {
  const { name, phone, address, savedAddresses } = req.body || {};

  if (name !== undefined && !isNonEmptyString(name)) {
    return res.status(400).json({ message: "Name cannot be empty" });
  }

  if (phone !== undefined && !isNonEmptyString(phone)) {
    return res.status(400).json({ message: "Phone cannot be empty" });
  }

  if (phone !== undefined && !isValidPhone(phone)) {
    return res.status(400).json({ message: "Phone number format is invalid" });
  }

  if (address !== undefined) {
    const hasAddressShape =
      typeof address === "object" &&
      (address.street === undefined || typeof address.street === "string") &&
      (address.city === undefined || typeof address.city === "string") &&
      (address.state === undefined || typeof address.state === "string") &&
      (address.zipCode === undefined || typeof address.zipCode === "string") &&
      (address.phone === undefined || typeof address.phone === "string");

    if (!hasAddressShape) {
      return res.status(400).json({ message: "Invalid address payload" });
    }
  }

  if (savedAddresses !== undefined && !Array.isArray(savedAddresses)) {
    return res.status(400).json({ message: "savedAddresses must be an array" });
  }

  return next();
};

module.exports = {
  validateRegister,
  validateLogin,
  validateGoogleLogin,
  validateProfileUpdate,
};
