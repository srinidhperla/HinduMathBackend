const crypto = require("crypto");
const Order = require("../models/Order");
const {
  razorpayClient,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
} = require("../config/razorpay");
const {
  resolveOrderErrorResponse,
  validateAndPriceOrder,
  createPersistedOrder,
} = require("../services/orderWorkflowService");

const createOrder = async (req, res) => {
  try {
    const clientOrderRequestId = String(
      req.body?.clientOrderRequestId || "",
    ).trim();

    if (clientOrderRequestId) {
      const existingOrder = await Order.findOne({
        user: req.user._id,
        clientOrderRequestId,
      })
        .populate("items.product")
        .populate("user", "name email phone")
        .populate("assignedDeliveryPartner", "name phone");

      if (existingOrder) {
        return res.status(200).json(existingOrder);
      }
    }

    const order = await createPersistedOrder({
      userId: req.user._id,
      orderData: req.body,
      paymentData: { paymentStatus: "pending" },
    });

    return res.status(201).json(order);
  } catch (error) {
    const { statusCode, payload } = resolveOrderErrorResponse(
      error,
      "Error creating order",
    );
    return res.status(statusCode).json(payload);
  }
};

const createPaymentOrder = async (req, res) => {
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

    return res.json({
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
    return res.status(statusCode).json(payload);
  }
};

const verifyPaymentAndCreateOrder = async (req, res) => {
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

    return res.status(201).json(order);
  } catch (error) {
    const { statusCode, payload } = resolveOrderErrorResponse(
      error,
      "Error verifying payment",
    );
    return res.status(statusCode).json(payload);
  }
};

module.exports = {
  createOrder,
  createPaymentOrder,
  verifyPaymentAndCreateOrder,
};
