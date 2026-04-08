const Order = require("../models/Order");
const User = require("../models/User");
const { emitOrderEvent } = require("../services/orderEvents");
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

    // Pre-validation before atomic update
    if (status === "confirmed") {
      const validEstimatedTimes = Object.keys(ESTIMATED_DELIVERY_LABELS);
      if (!validEstimatedTimes.includes(String(estimatedDeliveryTime || ""))) {
        return res.status(400).json({
          message: "Estimated delivery time is required for accepted orders",
        });
      }
      if (
        estimatedDeliveryTime === "custom" &&
        !String(customDeliveryTime || "").trim()
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
    }

    // Build atomic update operations
    const updateOps = { $set: {}, $push: {} };
    const now = new Date();

    updateOps.$set.status = status;

    if (status === "confirmed") {
      updateOps.$set.estimatedDeliveryTime = estimatedDeliveryTime;
      updateOps.$set.customDeliveryTime =
        estimatedDeliveryTime === "custom"
          ? String(customDeliveryTime || "").trim()
          : "";
      updateOps.$set.acceptanceMessage = String(acceptanceMessage || "").trim();
      updateOps.$set.rejectionReason = undefined;
      updateOps.$set.rejectionMessage = "";
    }

    if (status === "cancelled") {
      updateOps.$set.estimatedDeliveryTime = undefined;
      updateOps.$set.customDeliveryTime = "";
      updateOps.$set.rejectionReason = rejectionReason;
      updateOps.$set.rejectionMessage = String(rejectionMessage || "").trim();
      updateOps.$set.acceptanceMessage = "";
      updateOps.$set.deliveryStatus = "pending";
      updateOps.$set.assignedDeliveryPartner = null;
    }

    if (status === "pending") {
      updateOps.$set.pendingReminderEscalatedAt = null;
    }

    if (status === "delivered") {
      updateOps.$set.deliveryStatus = "delivered";
    } else if (status === "ready") {
      updateOps.$set.deliveryStatus = "outForDelivery";
    } else if (status !== "cancelled") {
      updateOps.$set.deliveryStatus = "pending";
    }

    if (assignedDeliveryPartner) {
      updateOps.$set.assignedDeliveryPartner = assignedDeliveryPartner;
      if (status !== "delivered") {
        updateOps.$set.deliveryStatus = "pending";
      }
    }

    // Sync payment status
    const paymentStatusByStatus = {
      cancelled: "failed",
      delivered: "completed",
    };
    if (paymentStatusByStatus[status]) {
      updateOps.$set.paymentStatus = paymentStatusByStatus[status];
    }

    updateOps.$push.statusTimeline = {
      status,
      actorRole: "admin",
      updatedAt: now,
    };

    // Capture previous status BEFORE the update for status transition detection
    const orderBefore = await Order.findById(req.params.id).select("status").lean();
    if (!orderBefore) {
      return res.status(404).json({ message: "Order not found" });
    }
    const previousStatus = orderBefore.status;

    // Use findOneAndUpdate with conditions to prevent race conditions
    const order = await Order.findOneAndUpdate(
      {
        _id: req.params.id,
        status: { $ne: status }, // Only update if status is changing
      },
      updateOps,
      { new: true },
    );

    // If order not found with status change, try without the status check
    // (in case only other fields are being updated)
    let finalOrder = order;
    if (!order) {
      finalOrder = await Order.findById(req.params.id);
      // Status already matches, update other fields if needed
      if (assignedDeliveryPartner) {
        finalOrder.assignedDeliveryPartner = assignedDeliveryPartner;
        if (finalOrder.deliveryStatus !== "delivered") {
          finalOrder.deliveryStatus = "pending";
        }
      }
      if (
        status === "confirmed" &&
        (estimatedDeliveryTime || acceptanceMessage !== undefined)
      ) {
        finalOrder.estimatedDeliveryTime =
          estimatedDeliveryTime || finalOrder.estimatedDeliveryTime;
        finalOrder.customDeliveryTime =
          finalOrder.estimatedDeliveryTime === "custom"
            ? String(
                customDeliveryTime || finalOrder.customDeliveryTime || "",
              ).trim()
            : "";
        finalOrder.acceptanceMessage =
          acceptanceMessage !== undefined
            ? String(acceptanceMessage || "").trim()
            : finalOrder.acceptanceMessage || "";
      }
      syncOrderPaymentStatus(finalOrder);
      await finalOrder.save();
    }

    if (status !== "pending") {
      clearOrderReminderRetries(finalOrder._id);
    } else {
      schedulePendingOrderPushRetries(finalOrder._id);
    }

    await populateOrderDetails(finalOrder);
    emitOrderEvent("order-status-updated", finalOrder.toObject());

    if (
      status === "confirmed" &&
      (previousStatus !== "confirmed" ||
        estimatedDeliveryTime !== undefined ||
        acceptanceMessage !== undefined)
    ) {
      sendOrderAcceptedEmail(finalOrder).catch((error) => {
        logger.error("Order accepted email failed", {
          orderId: finalOrder._id,
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
      sendOrderRejectedEmail(finalOrder).catch((error) => {
        logger.error("Order rejected email failed", {
          orderId: finalOrder._id,
          error: error.message,
        });
      });
    }

    if (previousStatus !== status) {
      sendOrderStatusProgressEmail(finalOrder, previousStatus).catch(
        (error) => {
          logger.error("Order status progress email failed", {
            orderId: finalOrder._id,
            error: error.message,
          });
        },
      );
    }

    return res.json(finalOrder);
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
      return res
        .status(403)
        .json({ message: "Not authorized to cancel this order" });
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
    syncOrderPaymentStatus(order);
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

    syncOrderPaymentStatus(order);

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
