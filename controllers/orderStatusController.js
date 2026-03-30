const Order = require("../models/Order");
const User = require("../models/User");
const {
  emitOrderEvent,
} = require("../services/orderEvents");
const {
  schedulePendingOrderPushRetries,
  clearOrderReminderRetries,
} = require("../services/orderReminderService");
const logger = require("../utils/logger");
const {
  ESTIMATED_DELIVERY_LABELS,
  sendOrderAcceptedEmail,
  sendOrderRejectedEmail,
  sendOrderStatusProgressEmail,
} = require("../services/orderWorkflowService");

const populateOrderDetails = async (order) => {
  await order.populate("items.product");
  await order.populate("user", "name email phone");
  await order.populate("assignedDeliveryPartner", "name phone");
};

const updateOrderStatus = async (req, res) => {
  try {
    const {
      status,
      estimatedDeliveryTime,
      customDeliveryTime,
      acceptanceMessage,
      rejectionReason,
      rejectionMessage,
      assignedDeliveryPartner,
    } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const previousStatus = order.status;

    if (status === "confirmed") {
      const resolvedEstimatedDeliveryTime =
        estimatedDeliveryTime || order.estimatedDeliveryTime;
      const validEstimatedTimes = Object.keys(ESTIMATED_DELIVERY_LABELS);
      if (!validEstimatedTimes.includes(String(resolvedEstimatedDeliveryTime || ""))) {
        return res.status(400).json({
          message: "Estimated delivery time is required for accepted orders",
        });
      }
      if (
        resolvedEstimatedDeliveryTime === "custom" &&
        !String(customDeliveryTime || order.customDeliveryTime || "").trim()
      ) {
        return res.status(400).json({
          message: "Custom delivery time is required when Custom is selected",
        });
      }
    }

    if (status === "cancelled" && !String(rejectionReason || "").trim()) {
      return res.status(400).json({
        message: "Rejection reason is required for rejected orders",
      });
    }

    if (assignedDeliveryPartner) {
      const deliveryPartner = await User.findOne({
        _id: assignedDeliveryPartner,
        role: "delivery",
      })
        .select("_id")
        .lean();

      if (!deliveryPartner) {
        return res.status(400).json({
          message: "Selected delivery partner was not found",
        });
      }

      order.assignedDeliveryPartner = deliveryPartner._id;
      if (order.deliveryStatus !== "delivered") {
        order.deliveryStatus = "pending";
      }
    }

    if (previousStatus !== status) {
      order.statusTimeline = [
        ...(Array.isArray(order.statusTimeline) ? order.statusTimeline : []),
        { status, actorRole: "admin", updatedAt: new Date() },
      ];
    }

    order.status = status;

    if (status === "confirmed") {
      order.estimatedDeliveryTime = estimatedDeliveryTime || order.estimatedDeliveryTime;
      order.customDeliveryTime =
        order.estimatedDeliveryTime === "custom"
          ? String(customDeliveryTime || order.customDeliveryTime || "").trim()
          : "";
      order.acceptanceMessage =
        acceptanceMessage !== undefined
          ? String(acceptanceMessage || "").trim()
          : order.acceptanceMessage || "";
      order.rejectionReason = undefined;
      order.rejectionMessage = "";
    }

    if (status === "cancelled") {
      order.estimatedDeliveryTime = undefined;
      order.customDeliveryTime = "";
      order.rejectionReason = rejectionReason;
      order.rejectionMessage = String(rejectionMessage || "").trim();
      order.acceptanceMessage = "";
      order.deliveryStatus = "pending";
      order.assignedDeliveryPartner = null;
      if (order.paymentStatus === "pending") {
        order.paymentStatus = "failed";
      }
    }

    if (status === "pending") {
      order.pendingReminderEscalatedAt = null;
    }

    await order.save();
    if (status !== "pending") {
      clearOrderReminderRetries(order._id);
    } else {
      schedulePendingOrderPushRetries(order._id);
    }

    await populateOrderDetails(order);
    emitOrderEvent("order-status-updated", order.toObject());

    if (
      status === "confirmed" &&
      (previousStatus !== "confirmed" ||
        estimatedDeliveryTime !== undefined ||
        acceptanceMessage !== undefined)
    ) {
      sendOrderAcceptedEmail(order).catch((error) => {
        logger.error("Order accepted email failed", {
          orderId: order._id,
          error: error.message,
        });
      });
    }

    if (
      status === "cancelled" &&
      (previousStatus !== "cancelled" ||
        rejectionReason !== undefined ||
        rejectionMessage !== undefined)
    ) {
      sendOrderRejectedEmail(order).catch((error) => {
        logger.error("Order rejected email failed", {
          orderId: order._id,
          error: error.message,
        });
      });
    }

    if (previousStatus !== status) {
      sendOrderStatusProgressEmail(order, previousStatus).catch((error) => {
        logger.error("Order status progress email failed", {
          orderId: order._id,
          error: error.message,
        });
      });
    }

    return res.json(order);
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error updating order status", error: error.message });
  }
};

const cancelOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not authorized to cancel this order" });
    }
    if (order.status !== "pending") {
      return res
        .status(400)
        .json({ message: "Order can only be cancelled before confirmation" });
    }

    if (order.status !== "cancelled") {
      order.statusTimeline = [
        ...(Array.isArray(order.statusTimeline) ? order.statusTimeline : []),
        { status: "cancelled", actorRole: "user", updatedAt: new Date() },
      ];
    }

    order.status = "cancelled";
    if (order.paymentStatus === "pending") {
      order.paymentStatus = "failed";
    }
    await order.save();
    clearOrderReminderRetries(order._id);
    await populateOrderDetails(order);
    emitOrderEvent("order-status-updated", order.toObject());

    return res.json({ message: "Order cancelled successfully", order });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error cancelling order", error: error.message });
  }
};

const updateDeliveryStatus = async (req, res) => {
  try {
    const { deliveryStatus } = req.body;
    if (!["outForDelivery", "delivered"].includes(String(deliveryStatus || ""))) {
      return res.status(400).json({
        message: "deliveryStatus must be outForDelivery or delivered",
      });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const previousStatus = String(order.status || "");
    const previousDeliveryStatus = String(order.deliveryStatus || "");

    if (
      !order.assignedDeliveryPartner ||
      order.assignedDeliveryPartner.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    if (deliveryStatus === "delivered") {
      if (order.status !== "delivered") {
        order.statusTimeline = [
          ...(Array.isArray(order.statusTimeline) ? order.statusTimeline : []),
          { status: "delivered", actorRole: "delivery", updatedAt: new Date() },
        ];
      }
      order.status = "delivered";
      order.deliveryStatus = "delivered";
      if (order.paymentMethod === "cash" && order.paymentStatus === "pending") {
        order.paymentStatus = "completed";
      }
    } else {
      if (order.status !== "ready") {
        order.statusTimeline = [
          ...(Array.isArray(order.statusTimeline) ? order.statusTimeline : []),
          { status: "ready", actorRole: "delivery", updatedAt: new Date() },
        ];
      }
      order.status = "ready";
      order.deliveryStatus = "outForDelivery";
    }

    await order.save();
    await populateOrderDetails(order);
    emitOrderEvent("order-status-updated", order.toObject());

    if (
      previousDeliveryStatus.toLowerCase() !==
        String(order.deliveryStatus || "").toLowerCase() ||
      previousStatus.toLowerCase() !== String(order.status || "").toLowerCase()
    ) {
      sendOrderStatusProgressEmail(order, previousStatus).catch((error) => {
        logger.error("Order status progress email failed", {
          orderId: order._id,
          error: error.message,
        });
      });
    }

    return res.json(order);
  } catch (error) {
    return res.status(500).json({
      message: "Error updating delivery status",
      error: error.message,
    });
  }
};

module.exports = {
  updateOrderStatus,
  cancelOrder,
  updateDeliveryStatus,
};

