const webpush = require("web-push");
const { GoogleAuth, JWT } = require("google-auth-library");
const AdminAlertDevice = require("../models/AdminAlertDevice");
const User = require("../models/User");
const logger = require("../utils/logger");

const getPushConfig = () => {
  const publicKey = process.env.VAPID_PUBLIC_KEY || "";
  const privateKey = process.env.VAPID_PRIVATE_KEY || "";
  const subject =
    process.env.VAPID_SUBJECT ||
    "mailto:admin@hindumathascakes.com";

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

const getExplicitFcmConfig = () => {
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

const FIREBASE_MESSAGING_SCOPE =
  "https://www.googleapis.com/auth/firebase.messaging";
const FCM_ORDER_ALERT_CHANNEL_ID = "order-alerts-v5";
const FCM_ORDER_ACTION_CATEGORY_ID = "admin-order-actions";
const FCM_ORDER_ALERT_SOUND = "default";
const FCM_ORDER_VIBRATION_PATTERN = [0, 250, 200, 250, 200, 350];

const getFcmProjectId = async () => {
  const configuredProjectId = String(
    process.env.FIREBASE_PROJECT_ID ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      "",
  ).trim();

  if (configuredProjectId) {
    return configuredProjectId;
  }

  try {
    const auth = new GoogleAuth({
      scopes: [FIREBASE_MESSAGING_SCOPE],
    });
    return String((await auth.getProjectId()) || "").trim();
  } catch {
    return "";
  }
};

const getFcmAccessToken = async () => {
  const explicitConfig = getExplicitFcmConfig();

  if (explicitConfig) {
    const jwtClient = new JWT({
      email: explicitConfig.clientEmail,
      key: explicitConfig.privateKey,
      scopes: [FIREBASE_MESSAGING_SCOPE],
    });

    const { access_token: accessToken } = await jwtClient.authorize();
    return accessToken || "";
  }

  try {
    const auth = new GoogleAuth({
      scopes: [FIREBASE_MESSAGING_SCOPE],
    });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    return String(tokenResponse?.token || tokenResponse || "").trim();
  } catch {
    return "";
  }
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
  const explicitFcmConfig = getExplicitFcmConfig();
  const fcmProjectId = await getFcmProjectId();
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
  const alertDeviceCount = await AdminAlertDevice.countDocuments({});

  return {
    configured: Boolean(webPushConfig || fcmProjectId),
    supported: true,
    mode: fcmProjectId ? "fcm" : webPushConfig ? "web-push" : "none",
    webPushConfigured: Boolean(webPushConfig),
    publicKey: webPushConfig?.publicKey || "",
    subject: webPushConfig?.subject || "",
    fcmConfigured: Boolean(fcmProjectId),
    fcmUsesExplicitServiceAccount: Boolean(explicitFcmConfig),
    fcmProjectId,
    subscribedAdminCount,
    fcmSubscribedAdminCount,
    alertDeviceCount,
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

const subscribeAlertDeviceFcm = async (
  token,
  { platform = "android", userAgent = "", appVersion = "" } = {},
) => {
  const sanitizedToken = String(token || "").trim();
  if (!sanitizedToken) {
    throw new Error("FCM token is required");
  }

  await AdminAlertDevice.findOneAndUpdate(
    { token: sanitizedToken },
    {
      $set: {
        platform: String(platform || "android").trim() || "android",
        source: "mobile-alert-app",
        userAgent: String(userAgent || "").slice(0, 250),
        appVersion: String(appVersion || "").slice(0, 50),
        lastSeenAt: new Date(),
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  );

  return { subscribed: true };
};

const unsubscribeAlertDeviceFcm = async (token) => {
  const sanitizedToken = String(token || "").trim();
  if (!sanitizedToken) {
    throw new Error("FCM token is required");
  }

  await AdminAlertDevice.deleteOne({ token: sanitizedToken });
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
  await AdminAlertDevice.deleteOne({ token });
};

const serializeFcmData = (input = {}) =>
  Object.entries(input).reduce((result, [key, value]) => {
    if (value === undefined || value === null) {
      return result;
    }

    result[key] =
      typeof value === "string" ? value : JSON.stringify(value);
    return result;
  }, {});

const sendFcmToAdmins = async ({
  title,
  body,
  url,
  tag,
  requireInteraction,
  icon,
  badge,
  vibrate,
  data = {},
}) => {
  const fcmProjectId = await getFcmProjectId();
  if (!fcmProjectId) {
    return { sent: false, sentCount: 0, reason: "fcm-not-configured" };
  }

  const adminUsers = await User.find({
    role: "admin",
    "fcmTokens.0": { $exists: true },
  }).select("fcmTokens");
  const alertDevices = await AdminAlertDevice.find({})
    .select("token")
    .lean();

  if (adminUsers.length === 0 && alertDevices.length === 0) {
    return { sent: false, sentCount: 0, reason: "no-fcm-subscribers" };
  }

  const accessToken = await getFcmAccessToken();
  if (!accessToken) {
    return { sent: false, sentCount: 0, reason: "fcm-token-unavailable" };
  }

  const endpoint = `https://fcm.googleapis.com/v1/projects/${fcmProjectId}/messages:send`;
  const tokenSet = new Set();
  for (const adminUser of adminUsers) {
    for (const entry of adminUser.fcmTokens || []) {
      if (entry?.token) {
        tokenSet.add(entry.token);
      }
    }
  }
  for (const device of alertDevices) {
    if (device?.token) {
      tokenSet.add(device.token);
    }
  }

  let sentCount = 0;

  for (const token of tokenSet) {
    const messageData = serializeFcmData({
      title,
      message: body,
      url: url || "/admin/orders",
      priority: "high",
      tag,
      requireInteraction: String(Boolean(requireInteraction)),
      sound: FCM_ORDER_ALERT_SOUND,
      sticky: String(Boolean(requireInteraction)),
      vibrate: JSON.stringify(vibrate || FCM_ORDER_VIBRATION_PATTERN),
      categoryId: FCM_ORDER_ACTION_CATEGORY_ID,
      ...data,
    });

    const messagePayload = {
      message: {
        token,
        data: messageData,
        android: {
          priority: "high",
          ttl: "30s",
          notification: {
            channel_id: FCM_ORDER_ALERT_CHANNEL_ID,
            sound: FCM_ORDER_ALERT_SOUND,
            default_sound: true,
            sticky: true,
            visibility: "PUBLIC",
            notification_priority: "PRIORITY_MAX",
            proxy: "DENY",
          },
        },
        notification: {
          title,
          body,
        },
        webpush: {
          headers: {
            Urgency: "high",
          },
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
            priority: "high",
            tag,
            requireInteraction: String(Boolean(requireInteraction)),
            orderId: String(data.orderId || ""),
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
  data = {},
}) => {
  const config = configureWebPush();
  const fcmProjectId = await getFcmProjectId();

  if (!config && !fcmProjectId) {
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
    data,
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
  const orderId = String(order?._id || "");
  const orderCode = String(order?.orderCode || orderId).toUpperCase();

  return sendPushToAdmins({
    title: "New bakery order",
    body: `${customerName} placed a new order. Open admin orders to accept it.`,
    url: "/admin/orders",
    tag: `order-${orderId}`,
    requireInteraction: true,
    data: {
      orderId,
      orderCode,
      pendingCount: "1",
    },
  });
};

const sendPendingReminderPush = async (order) => {
  const orderId = String(order?._id || "");
  const orderCode = String(order?.orderCode || orderId).toUpperCase();

  return sendPushToAdmins({
    title: "PENDING ORDER WAITING - Tap to open",
    body: "PENDING ORDER WAITING - Tap to open",
    url: "/admin/orders",
    tag: `pending-${orderId}`,
    requireInteraction: true,
    data: {
      orderId,
      orderCode,
      pendingCount: "1",
    },
  });
};

const sendPendingEscalationPush = async (order) => {
  const orderId = String(order?._id || "");
  const orderCode = String(order?.orderCode || orderId).toUpperCase();

  return sendPushToAdmins({
    title: "Order still pending - please check immediately",
    body: "Order still pending - please check immediately",
    url: "/admin/orders",
    tag: `pending-escalation-${orderId}`,
    requireInteraction: true,
    data: {
      orderId,
      orderCode,
      pendingCount: "1",
    },
  });
};

module.exports = {
  getPushStatus,
  subscribeAdminPush,
  unsubscribeAdminPush,
  subscribeAdminFcm,
  unsubscribeAdminFcm,
  subscribeAlertDeviceFcm,
  unsubscribeAlertDeviceFcm,
  sendNewOrderPush,
  sendPendingReminderPush,
  sendPendingEscalationPush,
};
