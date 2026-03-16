const BASE_API_URL = process.env.SMOKE_BASE_URL || "http://localhost:5000/api";
const FRONTEND_URL = process.env.SMOKE_FRONTEND_URL || "http://localhost:5173";

const ADMIN_EMAIL =
  process.env.SMOKE_ADMIN_EMAIL || "admin@hindumathascakes.com";
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD || "admin123";
const CUSTOMER_EMAIL =
  process.env.SMOKE_CUSTOMER_EMAIL || "qa.customer@example.com";
const CUSTOMER_PASSWORD = process.env.SMOKE_CUSTOMER_PASSWORD || "qa123456";
const CUSTOMER_NAME = process.env.SMOKE_CUSTOMER_NAME || "QA Customer";
const CUSTOMER_PHONE = process.env.SMOKE_CUSTOMER_PHONE || "9000000002";
const TEST_COUPON_CODE = process.env.SMOKE_COUPON_CODE || "QA15";

const TEST_ADDRESS = {
  street: process.env.SMOKE_ADDRESS_STREET || "221 QA Street, Test Nagar",
  city: process.env.SMOKE_ADDRESS_CITY || "Vizianagaram",
  state: process.env.SMOKE_ADDRESS_STATE || "Andhra Pradesh",
  zipCode: process.env.SMOKE_ADDRESS_ZIP || "535002",
};
const TEST_ADDRESS_LAT = Number(process.env.SMOKE_ADDRESS_LAT || NaN);
const TEST_ADDRESS_LNG = Number(process.env.SMOKE_ADDRESS_LNG || NaN);

const logStep = (message) => {
  console.log(`\n[smoke] ${message}`);
};

const fail = (message) => {
  throw new Error(message);
};

const request = async (path, options = {}) => {
  const response = await fetch(`${BASE_API_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
    method: options.method || "GET",
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const rawText = await response.text();
  const data = rawText ? JSON.parse(rawText) : null;

  if (!response.ok) {
    const message =
      data?.message || `${response.status} ${response.statusText}`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
};

const checkFrontend = async () => {
  const response = await fetch(FRONTEND_URL);
  if (!response.ok) {
    fail(`Frontend is not reachable at ${FRONTEND_URL}`);
  }
};

const login = async (email, password) =>
  request("/auth/login", {
    method: "POST",
    body: { email, password },
  });

const register = async (payload) =>
  request("/auth/register", {
    method: "POST",
    body: payload,
  });

const ensureCustomer = async () => {
  try {
    return await login(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
  } catch (error) {
    if (error.status !== 401) {
      throw error;
    }

    return register({
      name: CUSTOMER_NAME,
      email: CUSTOMER_EMAIL,
      password: CUSTOMER_PASSWORD,
      phone: CUSTOMER_PHONE,
    });
  }
};

const hasExplicitFlavors = (product) =>
  (Array.isArray(product?.flavorOptions) && product.flavorOptions.length > 0) ||
  (Array.isArray(product?.flavors) && product.flavors.length > 0);

const getFirstOrderableVariant = (product) => {
  const flavorOption =
    product.flavorOptions?.find((option) => option.isAvailable !== false)
      ?.name ||
    product.flavors?.[0] ||
    "";
  const weightOption =
    product.weightOptions?.find((option) => option.isAvailable !== false) ||
    null;
  const size = weightOption?.label || product.sizes?.[0] || "Default";
  const multiplier = weightOption?.multiplier || 1;

  return {
    flavor: hasExplicitFlavors(product) ? flavorOption : "",
    size,
    price: Number(product.price || 0) * multiplier,
  };
};

const toOrderItem = (productId, variant, quantity) => ({
  product: productId,
  quantity,
  size: variant.size,
  ...(variant.flavor ? { flavor: variant.flavor } : {}),
  price: variant.price,
});

const resolveDeliveryAddress = (siteContent) => {
  const storeLat = Number(siteContent?.deliverySettings?.storeLocation?.lat);
  const storeLng = Number(siteContent?.deliverySettings?.storeLocation?.lng);

  const lat = Number.isFinite(TEST_ADDRESS_LAT)
    ? TEST_ADDRESS_LAT
    : Number.isFinite(storeLat)
      ? storeLat + 0.005
      : 18.1067;
  const lng = Number.isFinite(TEST_ADDRESS_LNG)
    ? TEST_ADDRESS_LNG
    : Number.isFinite(storeLng)
      ? storeLng + 0.005
      : 83.3956;

  return {
    ...TEST_ADDRESS,
    lat,
    lng,
    label: "QA Address",
    formattedAddress: `${TEST_ADDRESS.street}, ${TEST_ADDRESS.city}`,
  };
};

const calculateCheckoutPrefill = (user) => ({
  name: user?.name || "",
  phone: user?.phone || "",
  address: user?.address?.street || "",
  city: user?.address?.city || "Vizianagaram",
  pincode: user?.address?.zipCode || "",
});

const main = async () => {
  logStep(`Checking frontend availability at ${FRONTEND_URL}`);
  await checkFrontend();

  logStep(`Logging in admin ${ADMIN_EMAIL}`);
  const adminSession = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const adminToken = adminSession.token;

  logStep("Fetching current site settings");
  const siteContent = await request("/site");
  const updatedCoupons = (siteContent.coupons || [])
    .filter((coupon) => coupon.code !== TEST_COUPON_CODE)
    .map((coupon) =>
      coupon.code === "FREEDEL" ? { ...coupon, isActive: false } : coupon,
    );

  updatedCoupons.push({
    code: TEST_COUPON_CODE,
    type: "percent",
    value: 15,
    minSubtotal: 700,
    maxDiscount: 300,
    description: "15% off on orders above Rs.700",
    isActive: true,
  });

  logStep(`Upserting test coupon ${TEST_COUPON_CODE} and disabling FREEDEL`);
  const savedSiteContent = await request("/site/settings", {
    method: "PUT",
    token: adminToken,
    body: {
      businessInfo: siteContent.businessInfo,
      storeHours: siteContent.storeHours,
      socialLinks: siteContent.socialLinks,
      coupons: updatedCoupons,
      deliverySettings: siteContent.deliverySettings,
    },
  });

  const activeCoupons = (savedSiteContent.coupons || []).filter(
    (coupon) => coupon.isActive !== false,
  );

  if (!activeCoupons.some((coupon) => coupon.code === TEST_COUPON_CODE)) {
    fail(`Coupon ${TEST_COUPON_CODE} was not saved as active`);
  }

  if (
    savedSiteContent.coupons?.some(
      (coupon) => coupon.code === "FREEDEL" && coupon.isActive !== false,
    )
  ) {
    fail("FREEDEL should be disabled for the smoke test");
  }

  logStep(`Ensuring smoke-test customer ${CUSTOMER_EMAIL} exists`);
  const customerSession = await ensureCustomer();
  const customerToken = customerSession.token;

  logStep("Updating customer profile with saved delivery details");
  const updatedProfile = await request("/auth/profile", {
    method: "PUT",
    token: customerToken,
    body: {
      name: CUSTOMER_NAME,
      phone: CUSTOMER_PHONE,
      address: TEST_ADDRESS,
    },
  });

  const prefill = calculateCheckoutPrefill(updatedProfile);
  if (
    prefill.address !== TEST_ADDRESS.street ||
    prefill.phone !== CUSTOMER_PHONE ||
    prefill.pincode !== TEST_ADDRESS.zipCode
  ) {
    fail("Checkout prefill does not match the updated customer profile");
  }

  logStep("Fetching product catalog");
  const products = await request("/products");
  const availableProducts = products.filter(
    (item) => item.isAvailable !== false,
  );
  const flavorProduct = availableProducts.find((item) =>
    hasExplicitFlavors(item),
  );
  const noFlavorProduct = availableProducts.find(
    (item) => !hasExplicitFlavors(item),
  );

  if (!flavorProduct) {
    fail("No available product with flavors found for smoke testing");
  }

  if (!noFlavorProduct) {
    fail("No available product without flavors found for smoke testing");
  }

  const flavorVariant = getFirstOrderableVariant(flavorProduct);
  const noFlavorVariant = getFirstOrderableVariant(noFlavorProduct);
  const testCoupon = activeCoupons.find(
    (coupon) => coupon.code === TEST_COUPON_CODE,
  );
  const minimumSubtotal = Number(testCoupon?.minSubtotal || 0);
  const pairPrice =
    Number(flavorVariant.price || 0) + Number(noFlavorVariant.price || 0);
  const quantity = Math.max(
    1,
    minimumSubtotal > 0 && pairPrice > 0
      ? Math.ceil(minimumSubtotal / pairPrice)
      : 1,
  );
  const deliveryDateTime = new Date(
    Date.now() + 24 * 60 * 60 * 1000,
  ).toISOString();
  const deliveryAddress = resolveDeliveryAddress(savedSiteContent);

  logStep(
    `Creating a smoke-test order with flavored + no-flavor items using coupon ${TEST_COUPON_CODE}`,
  );
  const order = await request("/orders", {
    method: "POST",
    token: customerToken,
    body: {
      items: [
        toOrderItem(flavorProduct._id, flavorVariant, quantity),
        toOrderItem(noFlavorProduct._id, noFlavorVariant, quantity),
      ],
      deliveryAddress,
      deliveryMode: "scheduled",
      deliveryDateTime,
      paymentMethod: "cash",
      couponCode: TEST_COUPON_CODE,
      specialInstructions: `Contact name: ${CUSTOMER_NAME} | Phone: ${CUSTOMER_PHONE}`,
    },
  });

  if (order.couponCode !== TEST_COUPON_CODE) {
    fail("Order was created without the expected coupon code");
  }

  logStep("Verifying the order appears in customer order history");
  const myOrders = await request("/orders/my-orders", {
    token: customerToken,
  });

  if (!myOrders.some((item) => item._id === order._id)) {
    fail("Created order is missing from the customer order history");
  }

  logStep("Verifying disabled coupon rejection");
  try {
    await request("/orders", {
      method: "POST",
      token: customerToken,
      body: {
        items: [
          toOrderItem(flavorProduct._id, flavorVariant, quantity),
          toOrderItem(noFlavorProduct._id, noFlavorVariant, quantity),
        ],
        deliveryAddress,
        deliveryMode: "scheduled",
        deliveryDateTime,
        paymentMethod: "cash",
        couponCode: "FREEDEL",
        specialInstructions: "Disabled coupon smoke test",
      },
    });
    fail("Disabled coupon FREEDEL should have been rejected");
  } catch (error) {
    if (!String(error.message || "").includes("Invalid coupon code")) {
      throw error;
    }
  }

  console.log("\n[smoke] Smoke test passed");
  console.log(
    JSON.stringify(
      {
        frontend: FRONTEND_URL,
        api: BASE_API_URL,
        customerEmail: CUSTOMER_EMAIL,
        couponCode: TEST_COUPON_CODE,
        flavorProductId: flavorProduct._id,
        noFlavorProductId: noFlavorProduct._id,
        orderId: order._id,
        totalAmount: order.totalAmount,
      },
      null,
      2,
    ),
  );
};

main().catch((error) => {
  console.error("\n[smoke] Smoke test failed");
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
