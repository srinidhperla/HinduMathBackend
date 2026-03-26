const VALID_PAYMENT_METHODS = new Set(["cash", "card", "upi"]);
const VALID_ORDER_STATUSES = new Set([
  "pending",
  "confirmed",
  "preparing",
  "ready",
  "delivered",
  "cancelled",
]);
const isValidPhone = (value) =>
  /^[+]?[0-9\s-]{10,15}$/.test(String(value || "").trim());

const hasValidOrderItems = (items) =>
  Array.isArray(items) &&
  items.length > 0 &&
  items.every((item) => item && item.product && Number(item.quantity) > 0);

const hasValidAddress = (deliveryAddress) =>
  deliveryAddress &&
  typeof deliveryAddress.street === "string" &&
  deliveryAddress.street.trim() &&
  typeof deliveryAddress.city === "string" &&
  deliveryAddress.city.trim() &&
  (deliveryAddress.phone === undefined ||
    (typeof deliveryAddress.phone === "string" &&
      isValidPhone(deliveryAddress.phone)));

const validateOrderBasePayload = (payload = {}) => {
  if (!hasValidOrderItems(payload.items)) {
    return "Order must contain at least one valid item";
  }

  if (!hasValidAddress(payload.deliveryAddress)) {
    return "Delivery address with street and city is required";
  }

  if (!VALID_PAYMENT_METHODS.has(payload.paymentMethod)) {
    return "Invalid payment method selected";
  }

  if (
    payload.deliveryMode === "scheduled" &&
    !String(payload.deliveryDateTime || "").trim()
  ) {
    return "Exact delivery date and time are required for scheduled mode";
  }

  return "";
};

const validateCreateOrder = (req, res, next) => {
  const error = validateOrderBasePayload(req.body || {});

  if (error) {
    return res.status(400).json({ message: error });
  }

  if (req.body.paymentMethod !== "cash") {
    return res.status(400).json({
      message: "Use the online payment flow for UPI or card orders",
    });
  }

  return next();
};

const validateCreatePaymentOrder = (req, res, next) => {
  const error = validateOrderBasePayload(req.body || {});

  if (error) {
    return res.status(400).json({ message: error });
  }

  if (req.body.paymentMethod === "cash") {
    return res.status(400).json({
      message: "Cash orders should use the direct create order endpoint",
    });
  }

  return next();
};

const validateVerifyPaymentAndCreateOrder = (req, res, next) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature, orderData } =
    req.body || {};

  if (
    !razorpayOrderId ||
    !razorpayPaymentId ||
    !razorpaySignature ||
    !orderData
  ) {
    return res.status(400).json({
      message: "Payment verification details are required",
    });
  }

  const error = validateOrderBasePayload(orderData);
  if (error) {
    return res.status(400).json({ message: error });
  }

  return next();
};

const validateOrderStatusUpdate = (req, res, next) => {
  const { status } = req.body || {};

  if (!VALID_ORDER_STATUSES.has(status)) {
    return res.status(400).json({ message: "Invalid order status" });
  }

  return next();
};

module.exports = {
  validateCreateOrder,
  validateCreatePaymentOrder,
  validateVerifyPaymentAndCreateOrder,
  validateOrderStatusUpdate,
};
