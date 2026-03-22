const Order = require("../models/Order");
const SiteContent = require("../models/SiteContent");
const {
  getEmailConfigurationStatus,
  isEmailConfigured,
  sendEmail,
} = require("./emailService");
const {
  sendNewOrderPush,
  sendPendingReminderPush,
} = require("./pushNotificationService");
const { SITE_KEY } = require("../config/constants");
const logger = require("../utils/logger");
const REMINDER_INTERVAL_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
const PUSH_RETRY_DELAYS_MS = [0, 20_000, 40_000, 60_000, 90_000];
const PUSH_REPEAT_INTERVAL_MS = 60 * 1000;

let reminderIntervalHandle = null;
const retryTimeoutsByOrderId = new Map();
const recurringPushIntervalsByOrderId = new Map();

const getAdminReminderEmail = async () => {
  if (process.env.ADMIN_ALERT_EMAIL) {
    return process.env.ADMIN_ALERT_EMAIL;
  }

  const siteContent = await SiteContent.findOne({
    singletonKey: SITE_KEY,
  }).lean();
  return siteContent?.businessInfo?.email || null;
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
  const timeoutHandles = retryTimeoutsByOrderId.get(key) || [];
  for (const handle of timeoutHandles) {
    clearTimeout(handle);
  }
  retryTimeoutsByOrderId.delete(key);

  const intervalHandle = recurringPushIntervalsByOrderId.get(key);
  if (intervalHandle) {
    clearInterval(intervalHandle);
    recurringPushIntervalsByOrderId.delete(key);
  }
};

const ensureRecurringPendingPush = (orderId) => {
  const key = String(orderId || "");
  if (!key || recurringPushIntervalsByOrderId.has(key)) {
    return;
  }

  const intervalHandle = setInterval(async () => {
    try {
      const order = await Order.findById(key).populate("user", "name");

      if (!order || order.status !== "pending") {
        clearOrderReminderRetries(key);
        return;
      }

      await sendPendingReminderPush(order);
    } catch (error) {
      logger.error("Recurring pending push failed", {
        orderId: key,
        error: error.message,
      });
    }
  }, PUSH_REPEAT_INTERVAL_MS);

  recurringPushIntervalsByOrderId.set(key, intervalHandle);
};

const sendPendingReminderPushForOrder = async (
  orderId,
  { attempt = 1 } = {},
) => {
  const order = await Order.findById(orderId).populate("user", "name");

  if (!order || order.status !== "pending") {
    return { skipped: true, reason: "order-not-pending" };
  }

  if (Number(attempt) <= 1) {
    await sendNewOrderPush(order);
  } else {
    await sendPendingReminderPush(order);
  }

  return { sent: true };
};

const schedulePendingOrderPushRetries = (orderId) => {
  if (!orderId) {
    return;
  }

  const key = String(orderId);
  clearOrderReminderRetries(key);

  const timeoutHandles = PUSH_RETRY_DELAYS_MS.map((delayMs, index) =>
    setTimeout(async () => {
      try {
        await sendPendingReminderPushForOrder(key, { attempt: index + 1 });

        if (index === PUSH_RETRY_DELAYS_MS.length - 1) {
          ensureRecurringPendingPush(key);
        }
      } catch (error) {
        logger.error("Pending order retry push failed", {
          orderId: key,
          attempt: index + 1,
          error: error.message,
        });
      } finally {
        if (index === PUSH_RETRY_DELAYS_MS.length - 1) {
          retryTimeoutsByOrderId.delete(key);
        }
      }
    }, delayMs),
  );

  retryTimeoutsByOrderId.set(key, timeoutHandles);
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
    return { skipped: true, reason: "smtp-not-configured" };
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

  Order.find({ status: "pending" })
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
  const recipient = await getAdminReminderEmail();
  const pendingOrderCount = await Order.countDocuments({ status: "pending" });

  return {
    ...getEmailConfigurationStatus(),
    recipient: recipient || "",
    reminderIntervalMinutes: REMINDER_INTERVAL_MS / (60 * 1000),
    pendingOrderCount,
  };
};

const sendTestReminderEmail = async () => {
  if (!isEmailConfigured()) {
    return { skipped: true, reason: "smtp-not-configured" };
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
      "If you received this, SMTP alert delivery is working.",
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
