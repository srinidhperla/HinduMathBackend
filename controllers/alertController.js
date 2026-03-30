const Order = require("../models/Order");
const User = require("../models/User");
const { emitOrderEvent } = require("../services/orderEvents");

const syncOrderPaymentStatus = (order) => {
  const paymentMethod = String(order?.paymentMethod || "").toLowerCase();
  const status = String(order?.status || "").toLowerCase();
  const isOnlinePayment = paymentMethod === "upi" || paymentMethod === "card";

  if (status === "cancelled") {
    order.paymentStatus = "failed";
    return;
  }

  if (isOnlinePayment) {
    order.paymentStatus = "completed";
    return;
  }

  if (paymentMethod === "cash") {
    order.paymentStatus = status === "delivered" ? "completed" : "pending";
  }
};

exports.getAlertOrders = async (req, res) => {
  try {
    const { status, limit } = req.query;
    const query = {};

    if (status) {
      query.status = status;
    }

    const parsedLimit = Number(limit);
    const resolvedLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 200)
        : 200;

    const orders = await Order.find(query)
      .populate("items.product", "name")
      .populate("user", "name phone")
      .sort({ createdAt: -1 })
      .limit(resolvedLimit)
      .lean();

    return res.json({
      count: orders.length,
      orders,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Error fetching alert orders",
      error: error.message,
    });
  }
};

exports.getAlertDeliveryPartners = async (req, res) => {
  try {
    const deliveryPartners = await User.find({ role: "delivery" })
      .select("_id name email phone")
      .sort({ name: 1 })
      .lean();

    return res.json(deliveryPartners);
  } catch (error) {
    return res.status(500).json({
      message: "Error fetching delivery partners",
      error: error.message,
    });
  }
};

exports.updateAlertDeliveryStatus = async (req, res) => {
  try {
    const { deliveryStatus } = req.body;
    if (
      !["outForDelivery", "delivered"].includes(String(deliveryStatus || ""))
    ) {
      return res.status(400).json({
        message: "deliveryStatus must be outForDelivery or delivered",
      });
    }

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (deliveryStatus === "delivered") {
      if (order.status !== "delivered") {
        order.statusTimeline = [
          ...(Array.isArray(order.statusTimeline) ? order.statusTimeline : []),
          {
            status: "delivered",
            actorRole: "admin",
            updatedAt: new Date(),
          },
        ];
      }
      order.status = "delivered";
    } else if (deliveryStatus === "outForDelivery") {
      if (order.status !== "ready") {
        order.statusTimeline = [
          ...(Array.isArray(order.statusTimeline) ? order.statusTimeline : []),
          {
            status: "ready",
            actorRole: "admin",
            updatedAt: new Date(),
          },
        ];
      }
      order.status = "ready";
    }

    order.deliveryStatus =
      deliveryStatus === "delivered" ? "delivered" : "outForDelivery";
    syncOrderPaymentStatus(order);

    await order.save();
    await order.populate("items.product");
    await order.populate("user", "name email phone");
    await order.populate("assignedDeliveryPartner", "name phone");

    emitOrderEvent("order-status-updated", order.toObject());

    return res.json(order);
  } catch (error) {
    return res.status(500).json({
      message: "Error updating delivery status",
      error: error.message,
    });
  }
};
