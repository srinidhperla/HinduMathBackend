const Order = require("../models/Order");
const Product = require("../models/Product");
const SiteContent = require("../models/SiteContent");
const crypto = require("crypto");
const {
  emitOrderEvent,
  subscribeToOrderEvents,
} = require("../services/orderEvents");
const { sendNewOrderPush } = require("../services/pushNotificationService");
const {
  sendPendingReminderForOrder,
} = require("../services/orderReminderService");
const {
  calculateOrderPricing,
  normalizeCouponCode,
} = require("../utils/orderPricing");
const { normalizeDeliverySettings } = require("../utils/deliverySettings");
const { isWithinDeliveryRadius } = require("../utils/distance");
const { SITE_KEY, DEFAULT_WEIGHT_MULTIPLIERS } = require("../config/constants");
const {
  razorpayClient,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
} = require("../config/razorpay");
const logger = require("../utils/logger");

const ENFORCED_MAX_DELIVERY_RADIUS_KM = 4;

const isConfiguredStoreLocation = (storeLocation) => {
  const lat = Number(storeLocation?.lat);
  const lng = Number(storeLocation?.lng);
  return (
    Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)
  );
};

const resolveOrderErrorResponse = (error, fallbackMessage) => {
  const message = String(error?.message || "").trim();
  const clientErrorPattern =
    /not found|not available|required|invalid|outside|delivery|coupon|scheduled|at least|unavailable|select/i;
  const statusCode = clientErrorPattern.test(message) ? 400 : 500;

  return {
    statusCode,
    payload: {
      message: message || fallbackMessage,
      error: message || fallbackMessage,
    },
  };
};

const getFlavorOptions = (product) => {
  if (Array.isArray(product.flavorOptions) && product.flavorOptions.length) {
    return product.flavorOptions;
  }

  return (product.flavors || []).map((flavor) => ({
    name: flavor,
    isAvailable: true,
  }));
};

const getWeightOptions = (product) => {
  if (Array.isArray(product.weightOptions) && product.weightOptions.length) {
    return product.weightOptions;
  }

  return (product.sizes || []).map((label) => ({
    label,
    multiplier: DEFAULT_WEIGHT_MULTIPLIERS[label] || 1,
    isAvailable: true,
  }));
};

const isFlavorWeightAvailable = (product, flavorName, weightLabel) => {
  if (!flavorName || !weightLabel) {
    return true;
  }

  const matrix = product?.flavorWeightAvailability;
  if (!matrix || typeof matrix !== "object") {
    return true;
  }

  const row =
    matrix[flavorName] ??
    matrix[String(flavorName).toLowerCase()] ??
    matrix?.get?.(flavorName) ??
    matrix?.get?.(String(flavorName).toLowerCase());

  if (!row || typeof row !== "object") {
    return true;
  }

  const value =
    row[weightLabel] ??
    row[String(weightLabel).toLowerCase()] ??
    row?.get?.(weightLabel) ??
    row?.get?.(String(weightLabel).toLowerCase());

  return value !== false;
};

const validateAndPriceOrder = async ({
  items,
  deliveryAddress,
  deliveryMode,
  deliveryDateTime,
  paymentMethod,
  specialInstructions,
  couponCode,
}) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Order must contain at least one item");
  }

  if (!deliveryAddress?.street || !deliveryAddress?.city) {
    throw new Error("Delivery details are required");
  }

  const deliveryLat = Number(deliveryAddress?.lat);
  const deliveryLng = Number(deliveryAddress?.lng);
  if (!Number.isFinite(deliveryLat) || !Number.isFinite(deliveryLng)) {
    throw new Error(
      "Please select a verified address from suggestions or current location",
    );
  }

  if (!["cash", "card", "upi"].includes(paymentMethod)) {
    throw new Error("Invalid payment method selected");
  }

  let subtotal = 0;
  const validatedItems = [];

  for (const item of items) {
    const product = await Product.findById(item.product);
    if (!product) {
      throw new Error(`Product ${item.product} not found`);
    }

    if (!product.isAvailable) {
      throw new Error(`Product ${product.name} is not available`);
    }

    const flavorOptions = getFlavorOptions(product);
    const weightOptions = getWeightOptions(product);

    if (item.flavor) {
      const selectedFlavor = flavorOptions.find(
        (option) => option.name.toLowerCase() === item.flavor.toLowerCase(),
      );

      if (!selectedFlavor || !selectedFlavor.isAvailable) {
        throw new Error(
          `${item.flavor} flavor is not available for ${product.name}`,
        );
      }
    }

    if (item.size) {
      const selectedWeight = weightOptions.find(
        (option) => option.label.toLowerCase() === item.size.toLowerCase(),
      );

      if (!selectedWeight || !selectedWeight.isAvailable) {
        throw new Error(`${item.size} is not available for ${product.name}`);
      }

      if (!isFlavorWeightAvailable(product, item.flavor, item.size)) {
        throw new Error(
          `${item.flavor} (${item.size}) is not available for ${product.name}`,
        );
      }
    }

    const selectedWeight = item.size
      ? weightOptions.find(
          (option) => option.label.toLowerCase() === item.size.toLowerCase(),
        )
      : null;

    let itemPrice = product.price * (selectedWeight?.multiplier || 1);
    if (item.customizations) {
      for (const customization of item.customizations) {
        const option = product.customization?.options?.find(
          (customizationOption) =>
            customizationOption.name === customization.name,
        );
        if (option) {
          itemPrice += option.price;
        }
      }
    }

    validatedItems.push({
      product: product._id,
      quantity: Number(item.quantity),
      size: item.size || "",
      flavor: item.flavor || "",
      customizations: item.customizations || [],
      price: itemPrice,
    });

    subtotal += itemPrice * Number(item.quantity);
  }

  const siteContent = await SiteContent.findOne({
    singletonKey: SITE_KEY,
  }).lean();
  const normalizedDeliverySettings = normalizeDeliverySettings(
    siteContent?.deliverySettings,
  );

  if (!normalizedDeliverySettings.acceptingOrders) {
    throw new Error("Delivery is currently unavailable");
  }

  const resolvedMode = deliveryMode === "scheduled" ? "scheduled" : "now";
  const prepMinutes = Number(normalizedDeliverySettings.prepTimeMinutes || 45);
  let resolvedDeliveryDate = new Date();
  let resolvedDeliveryTime = "ASAP";

  if (resolvedMode === "scheduled") {
    if (!deliveryDateTime) {
      throw new Error("Exact delivery date and time are required");
    }

    const parsedDateTime = new Date(deliveryDateTime);
    if (Number.isNaN(parsedDateTime.getTime())) {
      throw new Error("Invalid delivery date and time");
    }

    const earliestDateTime = new Date(Date.now() + prepMinutes * 60 * 1000);
    if (parsedDateTime < earliestDateTime) {
      throw new Error(
        `Scheduled delivery should be at least ${prepMinutes} minutes from now`,
      );
    }

    resolvedDeliveryDate = parsedDateTime;
    resolvedDeliveryTime = parsedDateTime.toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  }

  const storeLocation = siteContent?.deliverySettings?.storeLocation;
  const maxRadius = ENFORCED_MAX_DELIVERY_RADIUS_KM;

  if (!isConfiguredStoreLocation(storeLocation)) {
    throw new Error(
      "Store location is not configured. Please update it in admin delivery settings.",
    );
  }

  if (
    !isWithinDeliveryRadius(storeLocation, deliveryLat, deliveryLng, maxRadius)
  ) {
    throw new Error(
      `Delivery address is outside our ${maxRadius}km delivery area.`,
    );
  }

  const activeCoupons = (siteContent?.coupons || []).filter(
    (coupon) => coupon.isActive !== false,
  );

  const pricing = calculateOrderPricing({
    subtotal,
    couponCode,
    coupons: activeCoupons,
  });

  if (couponCode && pricing.couponError) {
    throw new Error(pricing.couponError);
  }

  return {
    validatedItems,
    pricing,
    orderFields: {
      deliveryAddress,
      deliveryMode: resolvedMode,
      deliveryDate: resolvedDeliveryDate,
      deliveryTime: resolvedDeliveryTime,
      paymentMethod,
      specialInstructions,
      couponCode: pricing.appliedCoupon
        ? normalizeCouponCode(pricing.appliedCoupon.code)
        : "",
    },
  };
};

const createPersistedOrder = async ({
  userId,
  orderData,
  paymentData = {},
}) => {
  const { validatedItems, pricing, orderFields } =
    await validateAndPriceOrder(orderData);

  const order = new Order({
    user: userId,
    items: validatedItems,
    subtotal: pricing.subtotal,
    deliveryFee: pricing.deliveryFee,
    discountAmount: pricing.discountAmount,
    totalAmount: pricing.totalAmount,
    deliveryAddress: orderFields.deliveryAddress,
    deliveryMode: orderFields.deliveryMode,
    deliveryDate: orderFields.deliveryDate,
    deliveryTime: orderFields.deliveryTime,
    paymentMethod: orderFields.paymentMethod,
    paymentStatus:
      paymentData.paymentStatus ||
      (orderFields.paymentMethod === "cash" ? "pending" : "completed"),
    paymentGateway: paymentData.paymentGateway || "",
    paymentGatewayOrderId: paymentData.paymentGatewayOrderId || "",
    paymentGatewayPaymentId: paymentData.paymentGatewayPaymentId || "",
    paymentGatewaySignature: paymentData.paymentGatewaySignature || "",
    statusTimeline: [
      {
        status: "pending",
        actorRole: "system",
      },
    ],
    couponCode: orderFields.couponCode,
    specialInstructions: orderFields.specialInstructions,
    // Pre-set lastReminderSentAt so the periodic cron does not race to send a
    // second email before the async sendPendingReminderForOrder call below
    // has a chance to update the field itself.
    lastReminderSentAt: new Date(),
  });

  await order.save();
  await order.populate("items.product");
  await order.populate("user", "name email phone");

  emitOrderEvent("order-created", order.toObject());
  sendNewOrderPush(order).catch((error) => {
    logger.error("New order push failed", { error: error.message });
  });
  sendPendingReminderForOrder(order._id, { force: true }).catch((error) => {
    logger.error("Immediate order reminder failed", { error: error.message });
  });

  return order;
};

// Create new order
exports.createOrder = async (req, res) => {
  try {
    const order = await createPersistedOrder({
      userId: req.user._id,
      orderData: req.body,
      paymentData: { paymentStatus: "pending" },
    });

    res.status(201).json(order);
  } catch (error) {
    const { statusCode, payload } = resolveOrderErrorResponse(
      error,
      "Error creating order",
    );
    res.status(statusCode).json(payload);
  }
};

exports.createPaymentOrder = async (req, res) => {
  try {
    if (!razorpayClient) {
      return res.status(503).json({
        message: "Online payment is not configured yet",
      });
    }

    const { pricing } = await validateAndPriceOrder(req.body);
    const razorpayOrder = await razorpayClient.orders.create({
      amount: Math.round(pricing.totalAmount * 100),
      currency: "INR",
      receipt: `bakery_${Date.now()}`,
      notes: {
        userId: req.user._id.toString(),
        paymentMethod: req.body.paymentMethod,
      },
    });

    res.json({
      keyId: RAZORPAY_KEY_ID,
      gatewayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      pricing,
    });
  } catch (error) {
    const { statusCode, payload } = resolveOrderErrorResponse(
      error,
      "Error creating payment order",
    );
    res.status(statusCode).json(payload);
  }
};

exports.verifyPaymentAndCreateOrder = async (req, res) => {
  try {
    if (!razorpayClient) {
      return res.status(503).json({
        message: "Online payment is not configured yet",
      });
    }

    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, orderData } =
      req.body;

    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (expectedSignature !== razorpaySignature) {
      return res.status(400).json({ message: "Payment signature is invalid" });
    }

    const existingOrder = await Order.findOne({
      paymentGatewayPaymentId: razorpayPaymentId,
    });

    if (existingOrder) {
      return res.json(existingOrder);
    }

    const order = await createPersistedOrder({
      userId: req.user._id,
      orderData,
      paymentData: {
        paymentStatus: "completed",
        paymentGateway: "razorpay",
        paymentGatewayOrderId: razorpayOrderId,
        paymentGatewayPaymentId: razorpayPaymentId,
        paymentGatewaySignature: razorpaySignature,
      },
    });

    res.status(201).json(order);
  } catch (error) {
    const { statusCode, payload } = resolveOrderErrorResponse(
      error,
      "Error verifying payment",
    );
    res.status(statusCode).json(payload);
  }
};

// Get user's orders
exports.getUserOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id })
      .populate("items.product")
      .sort({ createdAt: -1 });

    res.json(orders);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching orders", error: error.message });
  }
};

// Get single order
exports.getOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate("items.product")
      .populate("user", "name email phone");

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Check if user is authorized to view this order
    if (
      order.user._id.toString() !== req.user._id.toString() &&
      req.user.role !== "admin"
    ) {
      return res
        .status(403)
        .json({ message: "Not authorized to view this order" });
    }

    res.json(order);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching order", error: error.message });
  }
};

// Update order status (admin only)
exports.updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.status !== status) {
      order.statusTimeline = [
        ...(Array.isArray(order.statusTimeline) ? order.statusTimeline : []),
        {
          status,
          actorRole: "admin",
          updatedAt: new Date(),
        },
      ];
    }

    order.status = status;
    await order.save();

    await order.populate("items.product");
    await order.populate("user", "name email phone");

    emitOrderEvent("order-status-updated", order.toObject());

    res.json(order);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error updating order status", error: error.message });
  }
};

// Get all orders (admin only)
exports.getAllOrders = async (req, res) => {
  try {
    const { status, startDate, endDate } = req.query;
    let query = {};

    if (status) query.status = status;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const orders = await Order.find(query)
      .populate("items.product")
      .populate("user", "name email phone")
      .sort({ createdAt: -1 });

    res.json(orders);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching orders", error: error.message });
  }
};

exports.getOrderAnalytics = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const query = {};

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const orders = await Order.find(query)
      .populate("items.product", "name category")
      .lean();
    const productCount = await Product.countDocuments({});

    const nonCancelledOrders = orders.filter(
      (order) => order.status !== "cancelled",
    );
    const totalRevenue = nonCancelledOrders.reduce(
      (sum, order) => sum + Number(order.totalAmount || 0),
      0,
    );
    const averageOrderValue = nonCancelledOrders.length
      ? totalRevenue / nonCancelledOrders.length
      : 0;

    const categoryTotals = {};
    const productSales = {};
    const statusBreakdown = {};

    orders.forEach((order) => {
      statusBreakdown[order.status] = (statusBreakdown[order.status] || 0) + 1;

      (order.items || []).forEach((item) => {
        const category = item.product?.category || "other";
        const amount = Number(item.price || 0) * Number(item.quantity || 0);
        categoryTotals[category] = (categoryTotals[category] || 0) + amount;

        const productName = item.product?.name || "Custom";
        productSales[productName] =
          (productSales[productName] || 0) + Number(item.quantity || 0);
      });
    });

    res.json({
      totalRevenue,
      averageOrderValue,
      orderCount: orders.length,
      productCount,
      categoryTotals,
      statusBreakdown,
      topProducts: Object.entries(productSales)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 8),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      message: "Error fetching order analytics",
      error: error.message,
    });
  }
};

// Cancel order
exports.cancelOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Check if user is authorized to cancel this order
    if (order.user.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "Not authorized to cancel this order" });
    }

    // Users can cancel only before the bakery confirms the order.
    if (order.status !== "pending") {
      return res
        .status(400)
        .json({ message: "Order can only be cancelled before confirmation" });
    }

    if (order.status !== "cancelled") {
      order.statusTimeline = [
        ...(Array.isArray(order.statusTimeline) ? order.statusTimeline : []),
        {
          status: "cancelled",
          actorRole: "user",
          updatedAt: new Date(),
        },
      ];
    }

    order.status = "cancelled";
    if (order.paymentStatus === "pending") {
      order.paymentStatus = "failed";
    }
    await order.save();

    await order.populate("items.product");
    await order.populate("user", "name email phone");

    emitOrderEvent("order-status-updated", order.toObject());

    res.json({ message: "Order cancelled successfully", order });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error cancelling order", error: error.message });
  }
};

exports.streamOrders = async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  const unsubscribe = subscribeToOrderEvents((event) => {
    res.write(`event: ${event.eventName}\ndata: ${JSON.stringify(event)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    res.write(
      `event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`,
    );
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
};
