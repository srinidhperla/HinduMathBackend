const Order = require("../models/Order");
const Product = require("../models/Product");
const SiteContent = require("../models/SiteContent");
const Counter = require("../models/Counter");
const User = require("../models/User");
const crypto = require("crypto");
const {
  emitOrderEvent,
  subscribeToOrderEvents,
} = require("../services/orderEvents");
const {
  schedulePendingOrderPushRetries,
  clearOrderReminderRetries,
  sendPendingReminderForOrder,
} = require("../services/orderReminderService");
const {
  calculateOrderPricing,
  normalizeCouponCode,
} = require("../utils/orderPricing");
const {
  getAvailableSlotsForDate,
  getLeadTimeMinutes,
  normalizeDeliverySettings,
} = require("../utils/deliverySettings");
const { fetchDrivingDistance } = require("../services/googleMapsDistanceService");
const { SITE_KEY, DEFAULT_WEIGHT_MULTIPLIERS } = require("../config/constants");
const {
  razorpayClient,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
} = require("../config/razorpay");
const { sendEmail } = require("../services/emailService");
const logger = require("../utils/logger");

const DELIVERY_TIME_ZONE = "Asia/Kolkata";
const IST_OFFSET_MINUTES = 330;
const ORDER_SEQUENCE_KEY = "hm-order";
const ESTIMATED_DELIVERY_LABELS = {
  "15min": "15 minutes",
  "30min": "30 minutes",
  "45min": "45 minutes",
  "1hour": "1 hour",
  "1.5hours": "1.5 hours",
  "2hours": "2 hours",
  custom: "Custom",
};
const REJECTION_REASON_LABELS = {
  outOfStock: "Out of stock",
  tooFar: "Too far from delivery area",
  shopClosed: "Shop closed",
  other: "Other",
};
const ORDER_STATUS_EMAIL_LABELS = {
  pending: "Pending",
  confirmed: "Confirmed",
  preparing: "Preparing",
  ready: "Ready",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

const generateNextOrderCode = async () => {
  const counter = await Counter.findByIdAndUpdate(
    ORDER_SEQUENCE_KEY,
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  const sequence = Number(counter?.seq || 0);
  return `HM${String(sequence).padStart(6, "0")}`;
};

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
    /not found|not available|required|invalid|outside|delivery|coupon|scheduled|at least|unavailable|select|price changed|review your cart|outdated/i;
  const statusCode = clientErrorPattern.test(message) ? 400 : 500;

  return {
    statusCode,
    payload: {
      message: message || fallbackMessage,
      error: message || fallbackMessage,
    },
  };
};

const toLocalDateKey = (dateValue, timeZone = DELIVERY_TIME_ZONE) => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(new Date(dateValue));
};

const getLastNDates = (days) => {
  const dates = [];
  const now = new Date();

  for (let index = days - 1; index >= 0; index -= 1) {
    const dateValue = new Date(now);
    dateValue.setDate(now.getDate() - index);
    const key = toLocalDateKey(dateValue);
    dates.push({
      key,
      label: dateValue.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        timeZone: DELIVERY_TIME_ZONE,
      }),
    });
  }

  return dates;
};

const isDateTimeWithinSlot = (dateTime, dateKey, slot) => {
  const [startHour, startMinute] = String(slot?.startTime || "00:00")
    .split(":")
    .map((value) => Number(value) || 0);
  const [endHour, endMinute] = String(slot?.endTime || "00:00")
    .split(":")
    .map((value) => Number(value) || 0);

  const slotStart = new Date(dateKey);
  slotStart.setHours(startHour, startMinute, 0, 0);
  const slotEnd = new Date(dateKey);
  slotEnd.setHours(endHour, endMinute, 0, 0);

  return dateTime >= slotStart && dateTime < slotEnd;
};

const toMinutes = (timeValue = "") => {
  const [hours, minutes] = String(timeValue)
    .split(":")
    .map((value) => Number(value) || 0);
  return hours * 60 + minutes;
};

const formatDisplayTime = (timeValue = "00:00") => {
  const [hours, minutes] = String(timeValue)
    .split(":")
    .map((value) => Number(value) || 0);
  const dateValue = new Date();
  dateValue.setHours(hours, minutes, 0, 0);
  return dateValue.toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatDateTimeLabel = (dateValue, fallbackTime = "") => {
  const parsedDate = new Date(dateValue);
  if (Number.isNaN(parsedDate.getTime())) {
    return fallbackTime || "Not specified";
  }

  const dateLabel = parsedDate.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: DELIVERY_TIME_ZONE,
  });
  const timeLabel =
    fallbackTime ||
    parsedDate.toLocaleTimeString("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: DELIVERY_TIME_ZONE,
    });

  return `${dateLabel} at ${timeLabel}`;
};

const getRequestedDeliveryLabel = (order) => {
  if (order?.deliveryMode === "now") {
    return "Deliver now";
  }

  return formatDateTimeLabel(order?.deliveryDate, order?.deliveryTime);
};

const getEstimatedDeliveryLabel = (order) => {
  const key = String(order?.estimatedDeliveryTime || "").trim();

  if (!key) {
    return "";
  }

  if (key === "custom") {
    return String(order?.customDeliveryTime || "").trim();
  }

  return ESTIMATED_DELIVERY_LABELS[key] || key;
};

const formatAddressLabel = (address = {}) =>
  [
    address.street,
    address.landmark,
    address.city,
    address.state,
    address.zipCode,
  ]
    .filter(Boolean)
    .join(", ");

const trimText = (value) => String(value ?? "").trim();
const getOrderEmailReference = (order) =>
  trimText(order?.orderCode) || String(order?._id || "");

const formatEggTypeLabel = (eggType = "") => {
  if (String(eggType).toLowerCase() === "eggless") {
    return "Eggless";
  }

  if (String(eggType).toLowerCase() === "egg") {
    return "Egg";
  }

  return trimText(eggType);
};

const keyToOptionLabel = (key = "") => {
  const compact = String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
  const mappedLabels = {
    eggtype: "Cake Type",
    caketype: "Cake Type",
    flavor: "Flavor",
    size: "Size",
    weight: "Weight",
    occasion: "Occasion",
    custommessage: "Message on Cake",
    messageoncake: "Message on Cake",
    message: "Message on Cake",
    portion: "Portion",
    portiontype: "Portion",
  };

  if (mappedLabels[compact]) {
    return mappedLabels[compact];
  }

  return trimText(key)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const normalizeOptionValue = (value) => {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return trimText(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }

  return "";
};

const appendOptionEntry = (entries, label, value) => {
  const normalizedLabel = trimText(label);
  const normalizedValue = normalizeOptionValue(value);
  if (!normalizedLabel || !normalizedValue) {
    return;
  }

  entries.push({
    label: normalizedLabel,
    value: normalizedValue,
  });
};

const dedupeOptionEntries = (entries = []) => {
  const seen = new Set();
  const normalizedEntries = [];

  entries.forEach((entry) => {
    const label = trimText(entry?.label);
    const value = normalizeOptionValue(entry?.value);
    if (!label || !value) {
      return;
    }

    const dedupeKey = `${label.toLowerCase()}::${value.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      return;
    }

    seen.add(dedupeKey);
    normalizedEntries.push({ label, value });
  });

  return normalizedEntries;
};

const normalizeSelectedOptionEntries = (selectedOptions) => {
  const entries = [];

  if (Array.isArray(selectedOptions)) {
    selectedOptions.forEach((option) => {
      const label = trimText(option?.label || option?.name || option?.key);
      const value = normalizeOptionValue(
        option?.value ?? option?.choice ?? option?.selected,
      );
      appendOptionEntry(entries, label, value);
    });

    return dedupeOptionEntries(entries);
  }

  if (!selectedOptions || typeof selectedOptions !== "object") {
    return [];
  }

  Object.entries(selectedOptions).forEach(([key, rawValue]) => {
    if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      appendOptionEntry(
        entries,
        trimText(rawValue.label) || keyToOptionLabel(key),
        rawValue.value ?? rawValue.choice ?? rawValue.selected ?? "",
      );
      return;
    }

    appendOptionEntry(entries, keyToOptionLabel(key), rawValue);
  });

  return dedupeOptionEntries(entries);
};

const buildOrderItemSelectedOptions = ({
  item,
  selectedWeightLabel,
  resolvedEggType,
}) => {
  const entries = normalizeSelectedOptionEntries(item?.selectedOptions);
  const normalizedSize = trimText(item?.size || selectedWeightLabel || "");
  const normalizedWeight = trimText(item?.weight || normalizedSize);
  const normalizedFlavor = trimText(item?.flavor || "");
  const normalizedOccasion = trimText(item?.occasion || "");
  const normalizedMessage = trimText(
    item?.customMessage || item?.message || item?.cakeMessage || "",
  );
  const portionLabel = trimText(
    item?.portionLabel || item?.portionTypeLabel || item?.portionType || "",
  );

  appendOptionEntry(entries, "Size", normalizedSize);
  appendOptionEntry(entries, "Weight", normalizedWeight);
  appendOptionEntry(entries, "Flavor", normalizedFlavor);
  appendOptionEntry(entries, "Cake Type", formatEggTypeLabel(resolvedEggType));
  appendOptionEntry(entries, "Occasion", normalizedOccasion);
  appendOptionEntry(entries, "Message on Cake", normalizedMessage);
  appendOptionEntry(entries, "Portion", portionLabel);

  if (Array.isArray(item?.customizations)) {
    item.customizations.forEach((customization) => {
      appendOptionEntry(
        entries,
        trimText(customization?.name) || "Customization",
        trimText(customization?.choice),
      );
    });
  }

  return dedupeOptionEntries(entries);
};

const buildOrderItemOptionSummary = (selectedOptions = []) =>
  selectedOptions
    .map((entry) => `${entry.label}: ${entry.value}`)
    .filter(Boolean)
    .join(" | ");

const getOrderItemDisplayName = (item) =>
  trimText(item?.productName) || trimText(item?.product?.name) || "Product";

const buildOrderItemSummary = (order) =>
  (order?.items || [])
    .map((item) => {
      const parts = [getOrderItemDisplayName(item), `Qty ${Number(item.quantity) || 0}`];
      const optionSummary =
        trimText(item?.optionSummary) ||
        buildOrderItemOptionSummary(normalizeSelectedOptionEntries(item?.selectedOptions));
      if (optionSummary) {
        parts.push(optionSummary);
      } else {
        const fallbackSummary = [item?.size, item?.weight, item?.flavor]
          .map((value) => trimText(value))
          .filter(Boolean)
          .join(" | ");
        if (fallbackSummary) {
          parts.push(fallbackSummary);
        }
      }
      return `- ${parts.join(" | ")}`;
    })
    .join("\n");

const sendCustomerEmailSafely = async ({
  to,
  subject,
  text,
  html,
  context,
}) => {
  if (!String(to || "").trim()) {
    return { skipped: true, reason: "recipient-missing" };
  }

  try {
    const result = await sendEmail({ to, subject, text, html });

    if (result?.skipped) {
      logger.warn("Customer order email skipped", {
        ...context,
        to,
        subject,
        reason: result.reason,
      });
    }

    return result;
  } catch (error) {
    logger.error("Customer order email failed", {
      ...context,
      to,
      subject,
      error: error.message,
    });
    return { skipped: true, reason: "send-failed" };
  }
};

const sendOrderPlacedEmail = async (order) => {
  const itemSummary = buildOrderItemSummary(order);
  const requestedDelivery = getRequestedDeliveryLabel(order);
  const customerEmail = order?.user?.email;
  const orderReference = getOrderEmailReference(order);

  return sendCustomerEmailSafely({
    to: customerEmail,
    subject: `We received your order ${orderReference}`,
    text: [
      `Hi ${order.user?.name || "Customer"},`,
      "",
      "Your order has been placed successfully and is waiting for bakery confirmation.",
      `Order ID: ${orderReference}`,
      `Requested delivery: ${requestedDelivery}`,
      `Delivery address: ${formatAddressLabel(order.deliveryAddress)}`,
      `Total amount: Rs.${Number(order.totalAmount || 0).toLocaleString("en-IN")}`,
      "",
      "Items:",
      itemSummary || "- No items found",
      "",
      "We will notify you as soon as the bakery accepts or rejects the order.",
    ].join("\n"),
    context: {
      orderId: String(order?._id || ""),
      event: "order-placed",
    },
  });
};

const sendOrderAcceptedEmail = async (order) => {
  const estimatedLabel =
    getEstimatedDeliveryLabel(order) || "Will be shared soon";
  const requestedDelivery = getRequestedDeliveryLabel(order);
  const adminMessage = String(order?.acceptanceMessage || "").trim();
  const orderReference = getOrderEmailReference(order);

  return sendCustomerEmailSafely({
    to: order?.user?.email,
    subject: `Your order ${orderReference} is confirmed`,
    text: [
      `Hi ${order.user?.name || "Customer"},`,
      "",
      "Your order has been accepted by the bakery.",
      `Order ID: ${orderReference}`,
      `Requested delivery: ${requestedDelivery}`,
      `Estimated delivery time: ${estimatedLabel}`,
      adminMessage ? `Message from bakery: ${adminMessage}` : "",
      "",
      "Thank you for ordering with Hindumatha's Cake World.",
    ]
      .filter(Boolean)
      .join("\n"),
    context: {
      orderId: String(order?._id || ""),
      event: "order-accepted",
    },
  });
};

const sendOrderRejectedEmail = async (order) => {
  const rejectionReason =
    REJECTION_REASON_LABELS[order?.rejectionReason] ||
    String(order?.rejectionReason || "Order unavailable");
  const orderReference = getOrderEmailReference(order);

  return sendCustomerEmailSafely({
    to: order?.user?.email,
    subject: `Your order ${orderReference} was rejected`,
    text: [
      `Hi ${order.user?.name || "Customer"},`,
      "",
      "We are sorry, but the bakery could not accept your order.",
      `Order ID: ${orderReference}`,
      `Reason: ${rejectionReason}`,
      order?.rejectionMessage
        ? `Message from bakery: ${order.rejectionMessage}`
        : "",
      "",
      "Please place a new order or contact the bakery for help.",
    ]
      .filter(Boolean)
      .join("\n"),
    context: {
      orderId: String(order?._id || ""),
      event: "order-rejected",
    },
  });
};

const sendOrderStatusProgressEmail = async (order, previousStatus = "") => {
  const nextStatus = String(order?.status || "").trim().toLowerCase();
  const previous = String(previousStatus || "").trim().toLowerCase();

  if (!nextStatus || nextStatus === previous) {
    return { skipped: true, reason: "status-unchanged" };
  }

  if (["confirmed", "cancelled"].includes(nextStatus)) {
    return { skipped: true, reason: "handled-by-specific-template" };
  }

  const orderReference = getOrderEmailReference(order);
  const statusLabel =
    ORDER_STATUS_EMAIL_LABELS[nextStatus] ||
    nextStatus.charAt(0).toUpperCase() + nextStatus.slice(1);
  const requestedDelivery = getRequestedDeliveryLabel(order);
  const estimatedLabel = getEstimatedDeliveryLabel(order);

  return sendCustomerEmailSafely({
    to: order?.user?.email,
    subject: `Update: your order ${orderReference} is now ${statusLabel}`,
    text: [
      `Hi ${order.user?.name || "Customer"},`,
      "",
      `Your order status has been updated to: ${statusLabel}.`,
      `Order ID: ${orderReference}`,
      `Requested delivery: ${requestedDelivery}`,
      estimatedLabel ? `Estimated delivery: ${estimatedLabel}` : "",
      "",
      "Thank you for ordering with Hindumatha's Cake World.",
    ]
      .filter(Boolean)
      .join("\n"),
    context: {
      orderId: String(order?._id || ""),
      event: "order-status-progress",
      previousStatus: previous,
      nextStatus,
    },
  });
};

const getNowTimeParts = (
  baseDate = new Date(),
  timeZone = DELIVERY_TIME_ZONE,
) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(baseDate);
  const weekday =
    parts.find((part) => part.type === "weekday")?.value?.toLowerCase() ||
    "mon";
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(
    parts.find((part) => part.type === "minute")?.value || 0,
  );

  return { weekday, hour, minute };
};

const toDayKeyFromWeekday = (weekday = "mon") => {
  const mapping = {
    sun: "sunday",
    mon: "monday",
    tue: "tuesday",
    wed: "wednesday",
    thu: "thursday",
    fri: "friday",
    sat: "saturday",
  };

  return mapping[String(weekday).slice(0, 3).toLowerCase()] || "monday";
};

const createIstDateTime = (dateKey, timeValue = "00:00") => {
  const [year, month, day] = String(dateKey || "")
    .slice(0, 10)
    .split("-")
    .map((value) => Number(value));
  const [hours, minutes] = String(timeValue || "00:00")
    .split(":")
    .map((value) => Number(value));

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes)
  ) {
    return new Date(NaN);
  }

  const utcTimestamp =
    Date.UTC(year, month - 1, day, hours, minutes) -
    IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(utcTimestamp);
};

const parseScheduledDeliveryInput = (deliveryDateTime) => {
  const match = String(deliveryDateTime || "")
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);

  if (!match) {
    return null;
  }

  const [, dateKey, hours, minutes] = match;
  const parsedDate = createIstDateTime(dateKey, `${hours}:${minutes}`);
  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  return {
    dateKey,
    timeValue: `${hours}:${minutes}`,
    date: parsedDate,
  };
};

const isScheduledTimeInsideSlot = (timeValue, slot) => {
  const candidateMinutes = toMinutes(timeValue);
  const slotStartMinutes = toMinutes(slot?.startTime);
  const slotEndMinutes = toMinutes(slot?.endTime);

  return (
    candidateMinutes >= slotStartMinutes && candidateMinutes < slotEndMinutes
  );
};

const getDeliveryNowReason = (normalizedDeliverySettings, now = new Date()) => {
  if (!normalizedDeliverySettings?.enabled) {
    return "Delivery is currently turned off.";
  }

  if (normalizedDeliverySettings?.isPaused) {
    return `Delivery is paused until ${new Date(normalizedDeliverySettings.pauseUntil).toLocaleString("en-IN")}.`;
  }

  const nowParts = getNowTimeParts(now);
  const todayDayKey = toDayKeyFromWeekday(nowParts.weekday);
  const daySchedule = normalizedDeliverySettings?.weeklySchedule?.[todayDayKey];

  if (!daySchedule?.isOpen) {
    return `Delivery is closed on ${todayDayKey}.`;
  }

  const nowMinutes = nowParts.hour * 60 + nowParts.minute;
  const slots = (daySchedule.slots || [])
    .map((slot) => ({
      ...slot,
      startMinutes: toMinutes(slot.startTime),
      endMinutes: toMinutes(slot.endTime),
    }))
    .filter((slot) => slot.endMinutes > slot.startMinutes)
    .sort((left, right) => left.startMinutes - right.startMinutes);

  const isWithinCurrentWindow = slots.some(
    (slot) => nowMinutes >= slot.startMinutes && nowMinutes < slot.endMinutes,
  );

  if (isWithinCurrentWindow) {
    return "";
  }

  const nextWindow = slots.find((slot) => slot.startMinutes > nowMinutes);
  if (nextWindow) {
    return `Delivery opens today at ${formatDisplayTime(nextWindow.startTime)}.`;
  }

  return "Delivery is closed for today. Please schedule delivery.";
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

const getObjectEntries = (source) => {
  if (!source || typeof source !== "object") {
    return [];
  }

  if (source instanceof Map) {
    return Array.from(source.entries());
  }

  return Object.entries(source);
};

const resolveTypedRow = (source, typedKey) => {
  if (!source || typeof source !== "object") {
    return null;
  }

  const direct =
    source[typedKey] ||
    source?.get?.(typedKey) ||
    source[String(typedKey).toLowerCase()] ||
    source?.get?.(String(typedKey).toLowerCase());

  if (direct && typeof direct === "object") {
    return direct;
  }

  const typedKeyLower = String(typedKey).trim().toLowerCase();
  const matchedEntry = getObjectEntries(source).find(
    ([key]) => String(key || "").trim().toLowerCase() === typedKeyLower,
  );
  return matchedEntry && typeof matchedEntry[1] === "object"
    ? matchedEntry[1]
    : null;
};

const readRowValue = (row, label) => {
  if (!row || typeof row !== "object") {
    return undefined;
  }

  const normalizedLabel = String(label || "").trim();
  if (normalizedLabel in row) {
    return row[normalizedLabel];
  }

  const lowerLabel = normalizedLabel.toLowerCase();
  if (lowerLabel in row) {
    return row[lowerLabel];
  }

  const matchedEntry = getObjectEntries(row).find(
    ([key]) => String(key || "").trim().toLowerCase() === lowerLabel,
  );
  return matchedEntry ? matchedEntry[1] : undefined;
};

const readVariantPriceValue = (value) => {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  const nested = Number(value?.price);
  if (Number.isFinite(nested) && nested > 0) {
    return nested;
  }

  return null;
};

const isFlavorWeightAvailable = (
  product,
  flavorName,
  weightLabel,
  eggType = "",
) => {
  if (!flavorName || !weightLabel) {
    return true;
  }

  const matrix = product?.flavorWeightAvailability;
  if (!matrix || typeof matrix !== "object") {
    return true;
  }

  const typedKey = eggType ? `${eggType}::${flavorName}` : "";
  const typedRow = typedKey ? resolveTypedRow(matrix, typedKey) : null;

  if (eggType && !typedRow) {
    const hasAnyTypedFlavorRows = ["egg", "eggless"].some((type) => {
      const key = `${type}::${flavorName}`;
      return Boolean(resolveTypedRow(matrix, key));
    });

    if (hasAnyTypedFlavorRows) {
      return true;
    }
  }

  const row =
    typedRow ??
    matrix[flavorName] ??
    matrix[String(flavorName).toLowerCase()] ??
    matrix?.get?.(flavorName) ??
    matrix?.get?.(String(flavorName).toLowerCase());

  if (!row || typeof row !== "object") {
    return true;
  }

  const value = readRowValue(row, weightLabel);

  return value !== false && value !== null;
};

const resolveFlavorForPricing = (product, flavorName = "") => {
  if (flavorName) return flavorName;
  const availableFlavor = getFlavorOptions(product).find(
    (option) => option.isAvailable !== false,
  );
  return availableFlavor?.name || "Cake";
};

const getVariantPrice = (
  product,
  { flavorName = "", weightLabel = "", eggType = "" } = {},
) => {
  const weightOptions = getWeightOptions(product);
  const selectedWeight = weightOptions.find(
    (option) =>
      option.label.toLowerCase() === String(weightLabel).toLowerCase(),
  );

  if (!selectedWeight) {
    return Number(product?.price || 0);
  }

  const fallbackPrice =
    Number(product?.price || 0) * Number(selectedWeight.multiplier || 1);

  if (!eggType) {
    return fallbackPrice;
  }

  const source = product?.variantPrices;
  if (!source || typeof source !== "object") {
    return fallbackPrice;
  }

  const resolvedFlavor = resolveFlavorForPricing(product, flavorName);
  const typedKey = `${eggType}::${resolvedFlavor}`;
  const row = resolveTypedRow(source, typedKey);

  if (!row || typeof row !== "object") {
    return fallbackPrice;
  }

  const direct = readVariantPriceValue(readRowValue(row, weightLabel));
  if (direct !== null) {
    return direct;
  }

  return fallbackPrice;
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
    const hasEgg = product.isEgg !== false;
    const hasEggless = product.isEggless === true;
    const rawRequestedCakeType = trimText(item.cakeType || item.eggType);
    const requestedEggType =
      rawRequestedCakeType === "eggless" || rawRequestedCakeType === "egg"
        ? rawRequestedCakeType
        : "";
    const resolvedEggType =
      requestedEggType || (hasEggless && !hasEgg ? "eggless" : "egg");

    if (resolvedEggType === "eggless" && !hasEggless) {
      throw new Error(`${product.name} is not available in Eggless cake type`);
    }

    if (resolvedEggType === "egg" && !hasEgg) {
      throw new Error(`${product.name} is not available in Egg cake type`);
    }

    let selectedFlavor = null;
    if (item.flavor) {
      selectedFlavor = flavorOptions.find(
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

      if (
        !isFlavorWeightAvailable(
          product,
          item.flavor,
          item.size,
          resolvedEggType,
        )
      ) {
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

    let itemPrice = selectedWeight
      ? getVariantPrice(product, {
          flavorName: item.flavor,
          weightLabel: selectedWeight.label,
          eggType: resolvedEggType,
        })
      : Number(product.price || 0);
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

    // Always trust server-side product pricing so checkout doesn't fail when
    // admins update product prices while the customer is still on the payment page.

    const normalizedSize = trimText(selectedWeight?.label || item.size || "");
    const normalizedFlavor = trimText(selectedFlavor?.name || item.flavor || "");
    const normalizedWeight = trimText(item.weight || normalizedSize);
    const normalizedMessage = trimText(
      item.customMessage || item.message || item.cakeMessage || "",
    );
    const normalizedOccasion = trimText(item.occasion || "");
    const selectedOptions = buildOrderItemSelectedOptions({
      item,
      selectedWeightLabel: normalizedSize,
      resolvedEggType,
    });

    validatedItems.push({
      product: product._id,
      quantity: Number(item.quantity),
      productName: trimText(item.productName || product.name),
      productImage: trimText(
        item.productImage || product.images?.[0] || product.image || "",
      ),
      size: normalizedSize,
      weight: normalizedWeight,
      flavor: normalizedFlavor,
      cakeType: resolvedEggType,
      customMessage: normalizedMessage,
      occasion: normalizedOccasion,
      selectedOptions,
      optionSummary: buildOrderItemOptionSummary(selectedOptions),
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

  if (!normalizedDeliverySettings.enabled) {
    throw new Error("Delivery is currently turned off.");
  }

  const resolvedMode = deliveryMode === "scheduled" ? "scheduled" : "now";
  const leadTimeMinutes = getLeadTimeMinutes(normalizedDeliverySettings);
  let resolvedDeliveryDate = new Date();
  let resolvedDeliveryTime = "ASAP";

  if (resolvedMode === "scheduled") {
    if (!deliveryDateTime) {
      throw new Error("Exact delivery date and time are required");
    }

    const parsedInput = parseScheduledDeliveryInput(deliveryDateTime);
    if (!parsedInput) {
      throw new Error("Invalid delivery date and time");
    }

    const parsedDateTime = parsedInput.date;

    const earliestDateTime = new Date(Date.now() + leadTimeMinutes * 60 * 1000);
    if (parsedDateTime < earliestDateTime) {
      throw new Error(
        `Scheduled delivery should be at least ${leadTimeMinutes} minutes from now`,
      );
    }

    const scheduledDateKey = parsedInput.dateKey;
    const scheduledDaySlots = getAvailableSlotsForDate(
      normalizedDeliverySettings,
      scheduledDateKey,
      new Date(),
    );

    if (!scheduledDaySlots.isAvailable) {
      throw new Error(
        scheduledDaySlots.reason ||
          "No delivery slots are available for the selected date.",
      );
    }

    const isWithinAnySlot = (scheduledDaySlots.slots || []).some((slot) =>
      isScheduledTimeInsideSlot(parsedInput.timeValue, slot),
    );

    if (!isWithinAnySlot) {
      throw new Error(
        "Selected delivery time is outside the available delivery slots.",
      );
    }

    resolvedDeliveryDate = parsedDateTime;
    resolvedDeliveryTime = parsedDateTime.toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: DELIVERY_TIME_ZONE,
    });
  } else {
    const nowReason = getDeliveryNowReason(
      normalizedDeliverySettings,
      new Date(),
    );
    if (nowReason) {
      throw new Error(nowReason);
    }
  }

  const storeLocation = siteContent?.deliverySettings?.storeLocation;
  const maxRadius = Math.max(
    0,
    Number(normalizedDeliverySettings?.maxDeliveryRadiusKm) || 0,
  );

  if (!isConfiguredStoreLocation(storeLocation)) {
    throw new Error(
      "Store location is not configured. Please update it in admin delivery settings.",
    );
  }

  const { distanceKm: deliveryDistanceKm } = await fetchDrivingDistance({
    origin: {
      lat: Number(storeLocation?.lat),
      lng: Number(storeLocation?.lng),
    },
    destination: {
      lat: deliveryLat,
      lng: deliveryLng,
    },
  });

  if (deliveryDistanceKm > maxRadius) {
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
    deliveryDistanceKm,
    deliverySettings: normalizedDeliverySettings,
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
  const orderCode = await generateNextOrderCode();

  const order = new Order({
    user: userId,
    items: validatedItems,
    orderCode,
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
    clientOrderRequestId: String(orderData?.clientOrderRequestId || "").trim(),
    statusTimeline: [
      {
        status: "pending",
        actorRole: "system",
      },
    ],
    couponCode: orderFields.couponCode,
    specialInstructions: orderFields.specialInstructions,
    // Pre-set this so the 5-minute email reminder service doesn't race right
    // after order creation while retry push attempts are running.
    lastReminderSentAt: new Date(),
  });

  await order.save();
  await order.populate("items.product");
  await order.populate("user", "name email phone");
  await order.populate("assignedDeliveryPartner", "name phone");

  emitOrderEvent("order-created", order.toObject());
  schedulePendingOrderPushRetries(order._id);
  // Send an immediate admin email without blocking order placement.
  sendPendingReminderForOrder(order._id, { force: true }).catch((error) => {
    logger.error("Immediate pending order email failed", {
      orderId: order._id,
      error: error.message,
    });
  });
  sendOrderPlacedEmail(order).catch((error) => {
    logger.error("Order placed email failed", {
      orderId: order._id,
      error: error.message,
    });
  });

  return order;
};

// Create new order
exports.createOrder = async (req, res) => {
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
      .populate("assignedDeliveryPartner", "name phone")
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
      .populate("user", "name email phone")
      .populate("assignedDeliveryPartner", "name phone");

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Check if user is authorized to view this order
    if (
      order.user._id.toString() !== req.user._id.toString() &&
      req.user.role !== "admin" &&
      !(
        req.user.role === "delivery" &&
        order.assignedDeliveryPartner?._id?.toString() ===
          req.user._id.toString()
      )
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
      if (
        !validEstimatedTimes.includes(
          String(resolvedEstimatedDeliveryTime || ""),
        )
      ) {
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
        {
          status,
          actorRole: "admin",
          updatedAt: new Date(),
        },
      ];
    }

    order.status = status;

    if (status === "confirmed") {
      order.estimatedDeliveryTime =
        estimatedDeliveryTime || order.estimatedDeliveryTime;
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

    await order.populate("items.product");
    await order.populate("user", "name email phone");
    await order.populate("assignedDeliveryPartner", "name phone");

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
      .populate("assignedDeliveryPartner", "name phone")
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
    const [productCount, customerCount] = await Promise.all([
      Product.countDocuments({}),
      User.countDocuments({ role: "user" }),
    ]);
    const last30Days = getLastNDates(30);
    const dailyRevenueMap = new Map(last30Days.map((entry) => [entry.key, 0]));
    const ordersPerDayMap = new Map(last30Days.map((entry) => [entry.key, 0]));
    const todayKey = toLocalDateKey(new Date());

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
    let todayOrders = 0;
    let todayRevenue = 0;
    let pendingOrders = 0;

    orders.forEach((order) => {
      const createdKey = toLocalDateKey(order.createdAt || new Date());
      const isNotCancelled = order.status !== "cancelled";

      statusBreakdown[order.status] = (statusBreakdown[order.status] || 0) + 1;
      if (order.status === "pending") {
        pendingOrders += 1;
      }

      if (ordersPerDayMap.has(createdKey)) {
        ordersPerDayMap.set(
          createdKey,
          Number(ordersPerDayMap.get(createdKey) || 0) + 1,
        );
      }

      if (isNotCancelled && dailyRevenueMap.has(createdKey)) {
        dailyRevenueMap.set(
          createdKey,
          Number(dailyRevenueMap.get(createdKey) || 0) +
            Number(order.totalAmount || 0),
        );
      }

      if (createdKey === todayKey) {
        todayOrders += 1;
        if (isNotCancelled) {
          todayRevenue += Number(order.totalAmount || 0);
        }
      }

      (order.items || []).forEach((item) => {
        const category = item.product?.category || "other";
        const amount = Number(item.price || 0) * Number(item.quantity || 0);
        categoryTotals[category] = (categoryTotals[category] || 0) + amount;

        const productName = item.product?.name || "Custom";
        productSales[productName] = {
          name: productName,
          quantity:
            Number(productSales[productName]?.quantity || 0) +
            Number(item.quantity || 0),
          revenue: Number(productSales[productName]?.revenue || 0) + amount,
        };
      });
    });

    return res.json({
      totalRevenue,
      averageOrderValue,
      orderCount: orders.length,
      productCount,
      customerCount,
      todayOrders,
      todayRevenue,
      pendingOrders,
      categoryTotals,
      statusBreakdown,
      dailyRevenue: last30Days.map((entry) => ({
        date: entry.key,
        label: entry.label,
        revenue: Number(dailyRevenueMap.get(entry.key) || 0),
      })),
      ordersPerDay: last30Days.map((entry) => ({
        date: entry.key,
        label: entry.label,
        count: Number(ordersPerDayMap.get(entry.key) || 0),
      })),
      topProducts: Object.values(productSales)
        .sort((left, right) => right.quantity - left.quantity)
        .slice(0, 5),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
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
    clearOrderReminderRetries(order._id);

    await order.populate("items.product");
    await order.populate("user", "name email phone");
    await order.populate("assignedDeliveryPartner", "name phone");

    emitOrderEvent("order-status-updated", order.toObject());

    res.json({ message: "Order cancelled successfully", order });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error cancelling order", error: error.message });
  }
};

exports.getDeliveryPartners = async (req, res) => {
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

exports.getDeliveryPartnerOrders = async (req, res) => {
  try {
    const deliveryPartnerId = req.user._id;
    const orders = await Order.find({
      assignedDeliveryPartner: deliveryPartnerId,
      status: { $in: ["confirmed", "preparing", "ready"] },
      deliveryStatus: { $ne: "delivered" },
    })
      .populate("items.product", "name")
      .populate("user", "name phone email")
      .populate("assignedDeliveryPartner", "name phone")
      .sort({ createdAt: -1 });

    return res.json(orders);
  } catch (error) {
    return res.status(500).json({
      message: "Error fetching delivery orders",
      error: error.message,
    });
  }
};

exports.updateDeliveryStatus = async (req, res) => {
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

    order.deliveryStatus = deliveryStatus;

    if (deliveryStatus === "delivered") {
      if (order.status !== "delivered") {
        order.statusTimeline = [
          ...(Array.isArray(order.statusTimeline) ? order.statusTimeline : []),
          {
            status: "delivered",
            actorRole: "delivery",
            updatedAt: new Date(),
          },
        ];
      }
      order.status = "delivered";
      if (order.paymentMethod === "cash" && order.paymentStatus === "pending") {
        order.paymentStatus = "completed";
      }
    } else if (deliveryStatus === "outForDelivery") {
      if (order.status !== "ready") {
        order.statusTimeline = [
          ...(Array.isArray(order.statusTimeline) ? order.statusTimeline : []),
          {
            status: "ready",
            actorRole: "delivery",
            updatedAt: new Date(),
          },
        ];
      }
      order.status = "ready";
    }

    if (deliveryStatus === "delivered") {
      order.deliveryStatus = "delivered";
    } else {
      order.deliveryStatus = "outForDelivery";
    }

    await order.save();
    await order.populate("items.product");
    await order.populate("user", "name email phone");
    await order.populate("assignedDeliveryPartner", "name phone");

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

exports.resolveOrderErrorResponse = resolveOrderErrorResponse;
exports.validateAndPriceOrder = validateAndPriceOrder;
exports.createPersistedOrder = createPersistedOrder;
exports.toLocalDateKey = toLocalDateKey;
exports.getLastNDates = getLastNDates;
exports.sendOrderAcceptedEmail = sendOrderAcceptedEmail;
exports.sendOrderRejectedEmail = sendOrderRejectedEmail;
exports.sendOrderStatusProgressEmail = sendOrderStatusProgressEmail;
exports.ESTIMATED_DELIVERY_LABELS = ESTIMATED_DELIVERY_LABELS;
exports.ORDER_STATUS_EMAIL_LABELS = ORDER_STATUS_EMAIL_LABELS;

