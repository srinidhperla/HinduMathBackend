const Order = require("../models/Order");
const SiteContent = require("../models/SiteContent");
const {
  getEmailConfigurationStatus,
  isEmailConfigured,
  sendEmail,
} = require("./emailService");
const {
  sendPendingReminderPush,
  sendPendingEscalationPush,
} = require("./pushNotificationService");
const { SITE_KEY } = require("../config/constants");
const logger = require("../utils/logger");
const REMINDER_INTERVAL_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
const PUSH_REPEAT_INTERVAL_MS = 30 * 1000;
const PUSH_REPEAT_CAP_MS = 10 * 60 * 1000;

let reminderIntervalHandle = null;
const recurringPushIntervalsByOrderId = new Map();

const resolveAdminReminderEmail = async () => {
  if (process.env.ADMIN_ALERT_EMAIL) {
    return {
      recipient: process.env.ADMIN_ALERT_EMAIL,
      recipientSource: "ADMIN_ALERT_EMAIL",
    };
  }

  const siteContent = await SiteContent.findOne({
    singletonKey: SITE_KEY,
  }).lean();
  const fallbackRecipient = siteContent?.businessInfo?.email || "";

  return {
    recipient: fallbackRecipient,
    recipientSource: fallbackRecipient ? "siteContent.businessInfo.email" : "none",
  };
};

const getAdminReminderEmail = async () => {
  const { recipient } = await resolveAdminReminderEmail();
  return recipient || null;
};

const buildReminderEmail = (order) => {
  const customerName = order.user?.name || "Customer";
  const itemSummary = (order.items || [])
    .map((item) => {
      const parts = [
        item.product?.name || "Product",
        `Qty ${item.quantity || 0}`,
      ];
      if (item.size) {
        parts.push(item.size);
      }
      if (item.flavor) {
        parts.push(item.flavor);
      }
      return `- ${parts.join(" | ")}`;
    })
    .join("\n");

  const address = [
    order.deliveryAddress?.street,
    order.deliveryAddress?.city,
    order.deliveryAddress?.state,
    order.deliveryAddress?.zipCode,
  ]
    .filter(Boolean)
    .join(", ");

  const subject = `Pending bakery order needs acceptance #${order._id
    .toString()
    .slice(-6)
    .toUpperCase()}`;

  const text = [
    `A new order is still pending and has not been accepted yet.`,
    ``,
    `Order ID: ${order._id}`,
    `Customer: ${customerName}`,
    `Phone: ${order.user?.phone || "Not provided"}`,
    `Payment: ${order.paymentMethod || "Not specified"}`,
    `Delivery: ${order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString("en-IN") : "No date"}${order.deliveryTime ? ` at ${order.deliveryTime}` : ""}`,
    `Address: ${address || "Not provided"}`,
    `Total: Rs.${Number(order.totalAmount || 0).toLocaleString("en-IN")}`,
    ``,
    `Items:`,
    itemSummary || "- No items found",
    ``,
    `Please open the admin dashboard and accept the order.`,
  ].join("\n");

  return { subject, text };
};

const shouldSendReminder = (order) => {
  if (order.status !== "pending") {
    return false;
  }

  if (!order.lastReminderSentAt) {
    return true;
  }

  return (
    Date.now() - new Date(order.lastReminderSentAt).getTime() >=
    REMINDER_INTERVAL_MS
  );
};

const clearOrderReminderRetries = (orderId) => {
  const key = String(orderId || "");
  const intervalHandle = recurringPushIntervalsByOrderId.get(key);
  if (intervalHandle) {
    clearInterval(intervalHandle);
    recurringPushIntervalsByOrderId.delete(key);
  }
};

const getPendingStartedAt = (order) => {
  const timeline = Array.isArray(order?.statusTimeline)
    ? order.statusTimeline
    : [];
  const latestPendingEntry = [...timeline]
    .reverse()
    .find((entry) => entry?.status === "pending" && entry?.updatedAt);

  return latestPendingEntry?.updatedAt
    ? new Date(latestPendingEntry.updatedAt)
    : new Date(order?.createdAt || Date.now());
};

const hasExceededPushCap = (order) => {
  const pendingStartedAt = getPendingStartedAt(order);
  if (Number.isNaN(pendingStartedAt.getTime())) {
    return false;
  }

  return Date.now() - pendingStartedAt.getTime() >= PUSH_REPEAT_CAP_MS;
};

const sendPendingReminderPushForOrder = async (orderId) => {
  const order = await Order.findById(orderId)
    .populate("user", "name")
    .select("status createdAt statusTimeline pendingReminderEscalatedAt user");

  if (!order || order.status !== "pending") {
    return { skipped: true, reason: "order-not-pending" };
  }

  if (order.pendingReminderEscalatedAt) {
    return { skipped: true, reason: "cap-reached" };
  }

  if (hasExceededPushCap(order)) {
    await sendPendingEscalationPush(order);
    order.pendingReminderEscalatedAt = new Date();
    await order.save();
    return { sent: true, escalated: true, reason: "cap-reached" };
  }

  await sendPendingReminderPush(order);

  return { sent: true };
};

const schedulePendingOrderPushRetries = (orderId) => {
  if (!orderId) {
    return;
  }

  const key = String(orderId);
  clearOrderReminderRetries(key);

  sendPendingReminderPushForOrder(key).catch((error) => {
    logger.error("Pending order push failed", {
      orderId: key,
      error: error.message,
    });
  });

  const intervalHandle = setInterval(async () => {
    try {
      const result = await sendPendingReminderPushForOrder(key);

      if (result?.skipped || result?.escalated) {
        clearOrderReminderRetries(key);
      }
    } catch (error) {
      logger.error("Pending order repeat push failed", {
        orderId: key,
        error: error.message,
      });
    }
  }, PUSH_REPEAT_INTERVAL_MS);

  recurringPushIntervalsByOrderId.set(key, intervalHandle);
};

const sendPendingReminderForOrder = async (orderId, { force = false } = {}) => {
  const order = await Order.findById(orderId)
    .populate("items.product")
    .populate("user", "name email phone");

  if (!order || order.status !== "pending") {
    return { skipped: true, reason: "order-not-pending" };
  }

  if (!force && !shouldSendReminder(order)) {
    return { skipped: true, reason: "interval-not-reached" };
  }

  if (!isEmailConfigured()) {
    return { skipped: true, reason: "email-not-configured" };
  }

  const recipient = await getAdminReminderEmail();
  if (!recipient) {
    return { skipped: true, reason: "recipient-not-configured" };
  }

  const { subject, text } = buildReminderEmail(order);
  await sendEmail({ to: recipient, subject, text });

  order.lastReminderSentAt = new Date();
  order.reminderEmailCount = Number(order.reminderEmailCount || 0) + 1;
  await order.save();

  return { sent: true };
};

const processPendingOrderReminders = async () => {
  const threshold = new Date(Date.now() - REMINDER_INTERVAL_MS);
  const pendingOrders = await Order.find({
    status: "pending",
    $or: [
      { lastReminderSentAt: null },
      { lastReminderSentAt: { $lte: threshold } },
    ],
  }).select("_id");

  for (const order of pendingOrders) {
    try {
      await sendPendingReminderForOrder(order._id);
    } catch (error) {
      logger.error("Pending order reminder failed", { error: error.message });
    }
  }
};

const startOrderReminderService = () => {
  if (reminderIntervalHandle) {
    return;
  }

  Order.find({ status: "pending", pendingReminderEscalatedAt: null })
    .select("_id")
    .then((pendingOrders) => {
      for (const order of pendingOrders) {
        schedulePendingOrderPushRetries(order._id);
      }
    })
    .catch((error) => {
      logger.error("Failed to restore pending push schedules", {
        error: error.message,
      });
    });

  reminderIntervalHandle = setInterval(() => {
    processPendingOrderReminders().catch((error) => {
      logger.error("Pending order reminder scan failed", {
        error: error.message,
      });
    });
  }, CHECK_INTERVAL_MS);
};

const getReminderStatus = async () => {
  const { recipient, recipientSource } = await resolveAdminReminderEmail();
  const pendingOrderCount = await Order.countDocuments({ status: "pending" });

  return {
    ...getEmailConfigurationStatus(),
    recipient: recipient || "",
    recipientSource,
    reminderIntervalMinutes: REMINDER_INTERVAL_MS / (60 * 1000),
    pendingOrderCount,
  };
};

const sendTestReminderEmail = async () => {
  if (!isEmailConfigured()) {
    return { skipped: true, reason: "email-not-configured" };
  }

  const recipient = await getAdminReminderEmail();
  if (!recipient) {
    return { skipped: true, reason: "recipient-not-configured" };
  }

  const sentAt = new Date();
  await sendEmail({
    to: recipient,
    subject: `Bakery admin test alert ${sentAt.toLocaleTimeString("en-IN")}`,
    text: [
      "This is a test admin reminder email from Hindumatha's Cake World.",
      "",
      "If you received this, email alert delivery is working.",
      `Sent at: ${sentAt.toISOString()}`,
      `Reminder interval: ${REMINDER_INTERVAL_MS / (60 * 1000)} minutes`,
    ].join("\n"),
  });

  return { sent: true, recipient, sentAt: sentAt.toISOString() };
};

module.exports = {
  getReminderStatus,
  startOrderReminderService,
  sendTestReminderEmail,
  sendPendingReminderForOrder,
  sendPendingReminderPushForOrder,
  schedulePendingOrderPushRetries,
  clearOrderReminderRetries,
  processPendingOrderReminders,
};
