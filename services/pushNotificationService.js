const webpush = require("web-push");
const User = require("../models/User");
const logger = require("../utils/logger");

const getPushConfig = () => {
  const publicKey = process.env.VAPID_PUBLIC_KEY || "";
  const privateKey = process.env.VAPID_PRIVATE_KEY || "";
  const subject =
    process.env.VAPID_SUBJECT ||
    `mailto:${process.env.SMTP_FROM || process.env.SMTP_USER || "admin@hindumathascakes.com"}`;

  if (!publicKey || !privateKey) {
    return null;
  }

  return {
    publicKey,
    privateKey,
    subject,
  };
};

const configureWebPush = () => {
  const config = getPushConfig();
  if (!config) {
    return null;
  }

  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return config;
};

const normalizeSubscription = (subscription = {}) => ({
  endpoint: subscription.endpoint,
  expirationTime: subscription.expirationTime || null,
  keys: {
    p256dh: subscription.keys?.p256dh,
    auth: subscription.keys?.auth,
  },
});

const isValidSubscription = (subscription = {}) =>
  Boolean(
    subscription.endpoint &&
    subscription.keys?.p256dh &&
    subscription.keys?.auth,
  );

const getPushStatus = async () => {
  const config = getPushConfig();
  const subscribedAdminCount = await User.countDocuments({
    role: "admin",
    "pushSubscriptions.0": { $exists: true },
  });

  return {
    configured: Boolean(config),
    supported: true,
    publicKey: config?.publicKey || "",
    subject: config?.subject || "",
    subscribedAdminCount,
  };
};

const subscribeAdminPush = async (userId, subscription) => {
  if (!isValidSubscription(subscription)) {
    throw new Error("Invalid push subscription payload");
  }

  const normalizedSubscription = normalizeSubscription(subscription);
  const user = await User.findById(userId);

  if (!user || user.role !== "admin") {
    throw new Error("Admin user not found");
  }

  const existingIndex = (user.pushSubscriptions || []).findIndex(
    (entry) => entry.endpoint === normalizedSubscription.endpoint,
  );

  if (existingIndex >= 0) {
    user.pushSubscriptions[existingIndex] = normalizedSubscription;
  } else {
    user.pushSubscriptions.push(normalizedSubscription);
  }

  await user.save();
  return { subscribed: true };
};

const unsubscribeAdminPush = async (userId, endpoint) => {
  if (!endpoint) {
    throw new Error("Subscription endpoint is required");
  }

  const user = await User.findById(userId);
  if (!user || user.role !== "admin") {
    throw new Error("Admin user not found");
  }

  user.pushSubscriptions = (user.pushSubscriptions || []).filter(
    (entry) => entry.endpoint !== endpoint,
  );
  await user.save();

  return { unsubscribed: true };
};

const removeStaleSubscription = async (endpoint) => {
  if (!endpoint) {
    return;
  }

  await User.updateMany(
    { role: "admin" },
    { $pull: { pushSubscriptions: { endpoint } } },
  );
};

const sendPushToAdmins = async ({
  title,
  body,
  url,
  tag,
  requireInteraction = true,
}) => {
  const config = configureWebPush();
  if (!config) {
    return { skipped: true, reason: "push-not-configured" };
  }

  const adminUsers = await User.find({
    role: "admin",
    "pushSubscriptions.0": { $exists: true },
  }).select("pushSubscriptions");

  if (adminUsers.length === 0) {
    return { skipped: true, reason: "no-subscribers" };
  }

  const payload = JSON.stringify({
    title,
    body,
    url: url || "/admin/orders",
    tag: tag || "bakery-order-alert",
    requireInteraction,
  });

  let sentCount = 0;

  for (const adminUser of adminUsers) {
    for (const subscription of adminUser.pushSubscriptions || []) {
      try {
        await webpush.sendNotification(
          normalizeSubscription(subscription),
          payload,
        );
        sentCount += 1;
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await removeStaleSubscription(subscription.endpoint);
        } else {
          logger.error("Push notification failed", { error: error.message });
        }
      }
    }
  }

  return { sent: true, sentCount };
};

const sendNewOrderPush = async (order) => {
  const customerName = order.user?.name || "A customer";

  return sendPushToAdmins({
    title: "New bakery order",
    body: `${customerName} placed a new order. Open admin orders to accept it.`,
    url: "/admin/orders",
    tag: `order-${order._id}`,
    requireInteraction: true,
  });
};

const sendPendingReminderPush = async (order) => {
  return sendPushToAdmins({
    title: "Pending order still waiting",
    body: `Order #${order._id.toString().slice(-6).toUpperCase()} is still pending acceptance.`,
    url: "/admin/orders",
    tag: `pending-${order._id}`,
    requireInteraction: true,
  });
};

module.exports = {
  getPushStatus,
  subscribeAdminPush,
  unsubscribeAdminPush,
  sendNewOrderPush,
  sendPendingReminderPush,
};
