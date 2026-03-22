const BASE_DELIVERY_FEE = 60;
const FREE_DELIVERY_THRESHOLD = 1500;

const DEFAULT_COUPONS = {
  SWEET10: {
    code: "SWEET10",
    type: "percent",
    value: 10,
    minSubtotal: 500,
    maxDiscount: 250,
    description: "10% off on orders above Rs.500",
  },
  WELCOME100: {
    code: "WELCOME100",
    type: "flat",
    value: 100,
    minSubtotal: 800,
    description: "Rs.100 off on orders above Rs.800",
  },
  FREEDEL: {
    code: "FREEDEL",
    type: "delivery",
    value: 0,
    minSubtotal: 400,
    description: "Free delivery on eligible orders",
  },
};

const calculateDiscount = (coupon, subtotal, deliveryFee) => {
  if (!coupon) {
    return 0;
  }

  if (coupon.type === "percent") {
    const percentDiscount = Math.round((subtotal * coupon.value) / 100);
    return coupon.maxDiscount
      ? Math.min(percentDiscount, coupon.maxDiscount)
      : percentDiscount;
  }

  if (coupon.type === "flat") {
    return Math.min(coupon.value, subtotal);
  }

  if (coupon.type === "delivery") {
    return deliveryFee;
  }

  return 0;
};

const normalizeCouponCode = (couponCode = "") =>
  couponCode.trim().toUpperCase();

const toNonNegativeNumber = (value, fallback = 0) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0
    ? numericValue
    : fallback;
};

const resolveBaseDeliveryFee = ({
  subtotal,
  deliveryDistanceKm,
  deliverySettings,
}) => {
  const normalizedSubtotal = toNonNegativeNumber(subtotal, 0);
  const normalizedDistanceKm = toNonNegativeNumber(deliveryDistanceKm, 0);
  const legacyPricePerKm = toNonNegativeNumber(
    deliverySettings?.pricePerKm,
    20,
  );
  const normalizedFirstKmFee = toNonNegativeNumber(
    deliverySettings?.firstKmFee,
    legacyPricePerKm,
  );
  const normalizedPricePerKmBeyondFirstKm = toNonNegativeNumber(
    deliverySettings?.pricePerKmBeyondFirstKm,
    legacyPricePerKm,
  );
  const freeDeliveryEnabled = deliverySettings?.freeDeliveryEnabled !== false;
  const freeDeliveryMinAmount = toNonNegativeNumber(
    deliverySettings?.freeDeliveryMinAmount,
    FREE_DELIVERY_THRESHOLD,
  );

  if (freeDeliveryEnabled && normalizedSubtotal >= freeDeliveryMinAmount) {
    return 0;
  }

  if (deliverySettings?.distanceFeeEnabled === false) {
    return BASE_DELIVERY_FEE;
  }

  if (normalizedDistanceKm <= 0) {
    return 0;
  }

  if (normalizedDistanceKm <= 1) {
    return Math.max(0, Math.round(normalizedFirstKmFee));
  }

  return Math.max(
    0,
    Math.round(
      normalizedFirstKmFee +
        (normalizedDistanceKm - 1) * normalizedPricePerKmBeyondFirstKm,
    ),
  );
};

const calculateOrderPricing = ({
  subtotal = 0,
  couponCode = "",
  coupons,
  deliveryDistanceKm = 0,
  deliverySettings = {},
}) => {
  const normalizedSubtotal = Number(subtotal) || 0;
  const normalizedCouponCode = normalizeCouponCode(couponCode);
  const baseDeliveryFee = resolveBaseDeliveryFee({
    subtotal: normalizedSubtotal,
    deliveryDistanceKm,
    deliverySettings,
  });
  const couponCatalog = Object.fromEntries(
    Object.values(coupons || DEFAULT_COUPONS)
      .filter((coupon) => coupon && coupon.code)
      .map((coupon) => [coupon.code, coupon]),
  );

  if (!normalizedCouponCode) {
    return {
      subtotal: normalizedSubtotal,
      deliveryFee: baseDeliveryFee,
      discountAmount: 0,
      totalAmount: normalizedSubtotal + baseDeliveryFee,
      appliedCoupon: null,
      couponError: "",
    };
  }

  const coupon = couponCatalog[normalizedCouponCode];

  if (!coupon) {
    return {
      subtotal: normalizedSubtotal,
      deliveryFee: baseDeliveryFee,
      discountAmount: 0,
      totalAmount: normalizedSubtotal + baseDeliveryFee,
      appliedCoupon: null,
      couponError: "Invalid coupon code",
    };
  }

  if (coupon.minSubtotal && normalizedSubtotal < coupon.minSubtotal) {
    return {
      subtotal: normalizedSubtotal,
      deliveryFee: baseDeliveryFee,
      discountAmount: 0,
      totalAmount: normalizedSubtotal + baseDeliveryFee,
      appliedCoupon: null,
      couponError: `Coupon requires a minimum subtotal of Rs.${coupon.minSubtotal}`,
    };
  }

  const discountAmount = calculateDiscount(
    coupon,
    normalizedSubtotal,
    baseDeliveryFee,
  );
  const deliveryFee = Math.max(
    0,
    baseDeliveryFee - (coupon.type === "delivery" ? discountAmount : 0),
  );
  const totalAmount = Math.max(
    0,
    normalizedSubtotal -
      (coupon.type === "delivery" ? 0 : discountAmount) +
      deliveryFee,
  );

  return {
    subtotal: normalizedSubtotal,
    deliveryFee,
    discountAmount:
      coupon.type === "delivery" ? baseDeliveryFee : discountAmount,
    totalAmount,
    appliedCoupon: coupon,
    couponError: "",
  };
};

module.exports = {
  BASE_DELIVERY_FEE,
  FREE_DELIVERY_THRESHOLD,
  DEFAULT_COUPONS,
  calculateOrderPricing,
  normalizeCouponCode,
};
