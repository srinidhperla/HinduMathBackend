const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const createDefaultSlot = (startTime = "09:00", endTime = "21:00") => ({
  startTime,
  endTime,
});

const createDefaultWeeklySchedule = () => ({
  monday: { isOpen: true, slots: [createDefaultSlot("09:00", "21:00")] },
  tuesday: { isOpen: true, slots: [createDefaultSlot("09:00", "21:00")] },
  wednesday: { isOpen: true, slots: [createDefaultSlot("09:00", "21:00")] },
  thursday: { isOpen: true, slots: [createDefaultSlot("09:00", "21:00")] },
  friday: { isOpen: true, slots: [createDefaultSlot("09:00", "21:00")] },
  saturday: { isOpen: true, slots: [createDefaultSlot("09:00", "22:00")] },
  sunday: { isOpen: true, slots: [createDefaultSlot("09:00", "22:00")] },
});

const normalizeTimeValue = (value, fallback) => {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmedValue = value.trim();
  if (!/^\d{2}:\d{2}$/.test(trimmedValue)) {
    return fallback;
  }

  return trimmedValue;
};

const normalizeSlot = (slot, fallbackSlot) => {
  const startTime = normalizeTimeValue(slot?.startTime, fallbackSlot.startTime);
  const endTime = normalizeTimeValue(slot?.endTime, fallbackSlot.endTime);

  return { startTime, endTime };
};

const normalizePauseUntil = (pauseUntil, now = new Date()) => {
  if (!pauseUntil) {
    return null;
  }

  const parsedDate = new Date(pauseUntil);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate <= now) {
    return null;
  }

  return parsedDate.toISOString();
};

const normalizeDeliverySettings = (settings = {}) => {
  const pauseUntil = normalizePauseUntil(settings?.pauseUntil);
  const defaultWeeklySchedule = createDefaultWeeklySchedule();
  const weeklySchedule = {};

  Object.entries(defaultWeeklySchedule).forEach(([dayKey, fallbackDay]) => {
    const sourceDay = settings?.weeklySchedule?.[dayKey] || {};
    const slots =
      Array.isArray(sourceDay.slots) && sourceDay.slots.length
        ? sourceDay.slots.map((slot) =>
            normalizeSlot(slot, fallbackDay.slots[0]),
          )
        : fallbackDay.slots;

    weeklySchedule[dayKey] = {
      isOpen:
        typeof sourceDay.isOpen === "boolean"
          ? sourceDay.isOpen
          : fallbackDay.isOpen,
      slots,
    };
  });

  return {
    enabled: settings?.enabled !== false,
    pauseUntil,
    pauseDurationUnit:
      settings?.pauseDurationUnit === "days" ? "days" : "hours",
    pauseDurationValue: Math.max(0, Number(settings?.pauseDurationValue) || 0),
    isPaused: Boolean(pauseUntil),
    acceptingOrders: settings?.enabled !== false && !pauseUntil,
    prepTimeMinutes: Number(settings?.prepTimeMinutes) || 0,
    advanceNoticeUnit:
      settings?.advanceNoticeUnit === "days" ? "days" : "hours",
    advanceNoticeValue: Math.max(0, Number(settings?.advanceNoticeValue) || 0),
    timeSlots: Array.isArray(settings?.timeSlots) ? settings.timeSlots : [],
    weeklySchedule,
  };
};

const getLeadTimeMinutes = (deliverySettings) => {
  const normalizedSettings = normalizeDeliverySettings(deliverySettings);
  const advanceNoticeMinutes =
    normalizedSettings.advanceNoticeUnit === "days"
      ? normalizedSettings.advanceNoticeValue * 24 * 60
      : normalizedSettings.advanceNoticeValue * 60;

  return Math.max(
    advanceNoticeMinutes,
    normalizedSettings.prepTimeMinutes || 0,
  );
};

const parseSlotDateTime = (dateString, timeString) => {
  const [hours, minutes] = String(timeString || "00:00")
    .split(":")
    .map((value) => Number(value) || 0);
  const dateValue = new Date(dateString);
  dateValue.setHours(hours, minutes, 0, 0);
  return dateValue;
};

const getDayKeyForDate = (dateString) => {
  const dateValue = new Date(dateString);
  return DAY_KEYS[dateValue.getDay()] || "monday";
};

const getAvailableSlotsForDate = (
  deliverySettings,
  dateString,
  now = new Date(),
) => {
  const normalizedSettings = normalizeDeliverySettings(deliverySettings);

  if (!normalizedSettings.enabled) {
    return {
      isAvailable: false,
      reason: "Delivery is currently turned off.",
      slots: [],
    };
  }

  if (normalizedSettings.isPaused) {
    return {
      isAvailable: false,
      reason: `Delivery is paused until ${new Date(normalizedSettings.pauseUntil).toLocaleString("en-IN")}.`,
      slots: [],
    };
  }

  if (!dateString) {
    return {
      isAvailable: true,
      reason: "",
      slots: [],
    };
  }

  const dayKey = getDayKeyForDate(dateString);
  const daySchedule = normalizedSettings.weeklySchedule[dayKey];
  if (!daySchedule?.isOpen) {
    return {
      isAvailable: false,
      reason: `Delivery is off on ${dayKey}.`,
      slots: [],
    };
  }

  const minimumDeliveryDateTime = new Date(
    now.getTime() + getLeadTimeMinutes(normalizedSettings) * 60 * 1000,
  );
  const slots = (daySchedule.slots || []).filter((slot) => {
    const slotStart = parseSlotDateTime(dateString, slot.startTime);
    const slotEnd = parseSlotDateTime(dateString, slot.endTime);
    return slotStart < slotEnd && slotStart >= minimumDeliveryDateTime;
  });

  if (!slots.length) {
    return {
      isAvailable: false,
      reason:
        normalizedSettings.advanceNoticeUnit === "days"
          ? `No delivery slots are available for that day. Increase the delivery date by at least ${normalizedSettings.advanceNoticeValue} day(s).`
          : `No delivery slots are available after the current ${normalizedSettings.advanceNoticeValue}-hour notice window.`,
      slots: [],
    };
  }

  return {
    isAvailable: true,
    reason: "",
    slots,
  };
};

module.exports = {
  createDefaultWeeklySchedule,
  normalizeDeliverySettings,
  getLeadTimeMinutes,
  getAvailableSlotsForDate,
};
