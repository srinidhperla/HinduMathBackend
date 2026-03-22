const webpush = require("web-push");
const { JWT } = require("google-auth-library");
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

const getFcmConfig = () => {
  const projectId = process.env.FIREBASE_PROJECT_ID || "";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || "";
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(
    /\\n/g,
    "\n",
  );

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  return {
    projectId,
    clientEmail,
    privateKey,
  };
};

const getFcmAccessToken = async () => {
  const fcmConfig = getFcmConfig();
  if (!fcmConfig) {
    return "";
  }

  const jwtClient = new JWT({
    email: fcmConfig.clientEmail,
    key: fcmConfig.privateKey,
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });

  const { access_token: accessToken } = await jwtClient.authorize();
  return accessToken || "";
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
  const webPushConfig = getPushConfig();
  const fcmConfig = getFcmConfig();
  const subscribedAdminCount = await User.countDocuments({
    role: "admin",
    $or: [
      { "pushSubscriptions.0": { $exists: true } },
      { "fcmTokens.0": { $exists: true } },
    ],
  });
  const fcmSubscribedAdminCount = await User.countDocuments({
    role: "admin",
    "fcmTokens.0": { $exists: true },
  });

  return {
    configured: Boolean(webPushConfig || fcmConfig),
    supported: true,
    mode: fcmConfig ? "fcm" : webPushConfig ? "web-push" : "none",
    webPushConfigured: Boolean(webPushConfig),
    publicKey: webPushConfig?.publicKey || "",
    subject: webPushConfig?.subject || "",
    fcmConfigured: Boolean(fcmConfig),
    fcmProjectId: fcmConfig?.projectId || "",
    subscribedAdminCount,
    fcmSubscribedAdminCount,
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

const subscribeAdminFcm = async (userId, token, userAgent = "") => {
  const sanitizedToken = String(token || "").trim();
  if (!sanitizedToken) {
    throw new Error("FCM token is required");
  }

  const user = await User.findById(userId);
  if (!user || user.role !== "admin") {
    throw new Error("Admin user not found");
  }

  const existingIndex = (user.fcmTokens || []).findIndex(
    (entry) => entry.token === sanitizedToken,
  );

  if (existingIndex >= 0) {
    user.fcmTokens[existingIndex].lastSeenAt = new Date();
    user.fcmTokens[existingIndex].userAgent = String(userAgent || "").slice(
      0,
      250,
    );
  } else {
    user.fcmTokens.push({
      token: sanitizedToken,
      userAgent: String(userAgent || "").slice(0, 250),
      lastSeenAt: new Date(),
    });
  }

  await user.save();
  return { subscribed: true };
};

const unsubscribeAdminFcm = async (userId, token) => {
  const sanitizedToken = String(token || "").trim();
  if (!sanitizedToken) {
    throw new Error("FCM token is required");
  }

  const user = await User.findById(userId);
  if (!user || user.role !== "admin") {
    throw new Error("Admin user not found");
  }

  user.fcmTokens = (user.fcmTokens || []).filter(
    (entry) => entry.token !== sanitizedToken,
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

const removeStaleFcmToken = async (token) => {
  if (!token) {
    return;
  }

  await User.updateMany({ role: "admin" }, { $pull: { fcmTokens: { token } } });
};

const sendFcmToAdmins = async ({
  title,
  body,
  url,
  tag,
  requireInteraction,
  icon,
  badge,
  vibrate,
}) => {
  const fcmConfig = getFcmConfig();
  if (!fcmConfig) {
    return { sent: false, sentCount: 0, reason: "fcm-not-configured" };
  }

  const adminUsers = await User.find({
    role: "admin",
    "fcmTokens.0": { $exists: true },
  }).select("fcmTokens");

  if (adminUsers.length === 0) {
    return { sent: false, sentCount: 0, reason: "no-fcm-subscribers" };
  }

  const accessToken = await getFcmAccessToken();
  if (!accessToken) {
    return { sent: false, sentCount: 0, reason: "fcm-token-unavailable" };
  }

  const endpoint = `https://fcm.googleapis.com/v1/projects/${fcmConfig.projectId}/messages:send`;
  const tokenSet = new Set();
  for (const adminUser of adminUsers) {
    for (const entry of adminUser.fcmTokens || []) {
      if (entry?.token) {
        tokenSet.add(entry.token);
      }
    }
  }

  let sentCount = 0;

  for (const token of tokenSet) {
    const messagePayload = {
      message: {
        token,
        notification: {
          title,
          body,
        },
        webpush: {
          notification: {
            title,
            body,
            requireInteraction,
            tag,
            icon,
            badge,
            vibrate,
          },
          fcmOptions: {
            link: url || "/admin/orders",
          },
          data: {
            title,
            body,
            url: url || "/admin/orders",
            tag,
            requireInteraction: String(Boolean(requireInteraction)),
          },
        },
      },
    };

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(messagePayload),
      });

      if (!response.ok) {
        const responseBody = await response.json().catch(() => ({}));
        const errorCode = responseBody?.error?.details?.[0]?.errorCode || "";

        if (errorCode === "UNREGISTERED") {
          await removeStaleFcmToken(token);
          continue;
        }

        logger.error("FCM notification failed", {
          status: response.status,
          error: responseBody?.error?.message || "Unknown FCM error",
        });
        continue;
      }

      sentCount += 1;
    } catch (error) {
      logger.error("FCM notification failed", { error: error.message });
    }
  }

  return {
    sent: sentCount > 0,
    sentCount,
  };
};

const sendPushToAdmins = async ({
  title,
  body,
  url,
  tag,
  requireInteraction = true,
  icon = "/favicon.ico",
  badge = "/favicon.ico",
  vibrate = [200, 120, 220, 120, 260],
}) => {
  const config = configureWebPush();
  const fcmConfig = getFcmConfig();

  if (!config && !fcmConfig) {
    return { skipped: true, reason: "push-not-configured" };
  }

  const payload = JSON.stringify({
    title,
    body,
    url: url || "/admin/orders",
    tag: tag || "bakery-order-alert",
    requireInteraction,
    icon,
    badge,
    vibrate,
  });

  let webPushSentCount = 0;

  if (config) {
    const adminUsers = await User.find({
      role: "admin",
      "pushSubscriptions.0": { $exists: true },
    }).select("pushSubscriptions");

    for (const adminUser of adminUsers) {
      for (const subscription of adminUser.pushSubscriptions || []) {
        try {
          await webpush.sendNotification(
            normalizeSubscription(subscription),
            payload,
          );
          webPushSentCount += 1;
        } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) {
            await removeStaleSubscription(subscription.endpoint);
          } else {
            logger.error("Push notification failed", { error: error.message });
          }
        }
      }
    }
  }

  const fcmResult = await sendFcmToAdmins({
    title,
    body,
    url,
    tag,
    requireInteraction,
    icon,
    badge,
    vibrate,
  });

  const sentCount = webPushSentCount + Number(fcmResult.sentCount || 0);

  return {
    sent: sentCount > 0,
    sentCount,
    webPushSentCount,
    fcmSentCount: Number(fcmResult.sentCount || 0),
  };
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
  subscribeAdminFcm,
  unsubscribeAdminFcm,
  sendNewOrderPush,
  sendPendingReminderPush,
};
