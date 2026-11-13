const mongoose = require("mongoose");
const BillingBill = require("../models/BillingBill");
const Product = require("../models/Product");
const { ErpMeta } = require("../models/erpModels");
const logger = require("../utils/logger");
const { invalidatePublicCache } = require("../services/productWorkflowService");
const {
  emitSiteDataUpdated,
  emitAdminDataUpdated,
} = require("../services/orderEvents");
const BillingCategory = require("../models/BillingCategory");
const {
  PAYMENT_MODES,
  UNCATEGORISED,
  round2,
  dateKeyOf,
  isDateKey,
  isTime,
  istDate,
  shiftDateKey,
  toCategory,
  loadCategories,
  isValueCategory,
  valueCandidates,
  loadCatalog,
  toCatalogItem,
  resolveLines,
  computeBill,
  reserveBillNumbers,
  summarisePaymentMode,
} = require("../services/billingService");
const {
  generatePlan,
  MAX_BILL_AMOUNT,
  MAX_BILLS,
} = require("../services/autoBillingService");

const PLACEHOLDER_IMAGE =
  "https://res.cloudinary.com/dh39jlcy0/image/upload/f_auto,q_auto,w_800/v1/hindumatha/erp-placeholder.png";

const DEFAULT_SHOP = {
  shopName: "Hindumatha's Cake World",
  address: "",
  phone: "",
  gstin: "",
  fssaiNo: "",
  receiptFooter: "Thank you! Visit again.",
};

const fail = (res, error, fallback) => {
  const status = error.statusCode || 500;
  if (status >= 500) {
    logger.error(fallback, { error: error.message });
  }
  return res
    .status(status)
    .json({ message: status >= 500 ? fallback : error.message });
};

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

const readShop = async () => {
  const meta = await ErpMeta.findOne({ key: "main" }).select("settings").lean();
  const settings = meta?.settings || {};
  return Object.fromEntries(
    Object.keys(DEFAULT_SHOP).map((key) => [key, settings[key] || DEFAULT_SHOP[key]]),
  );
};

/* ── Aggregation helpers ────────────────────────────────────────────────── */

const emptyModeTotals = () =>
  Object.fromEntries(PAYMENT_MODES.map((mode) => [mode, 0]));

const summarise = (bills) => {
  const modes = emptyModeTotals();
  let sales = 0;
  let discount = 0;
  let itemsSold = 0;
  let autoBills = 0;
  let autoSales = 0;

  bills.forEach((bill) => {
    sales += bill.grandTotal;
    discount += bill.discount || 0;
    itemsSold += bill.itemCount || 0;
    if (bill.source === "auto") {
      autoBills += 1;
      autoSales += bill.grandTotal;
    }
    (bill.payments || []).forEach((payment) => {
      modes[payment.mode] = (modes[payment.mode] || 0) + payment.amount;
    });
  });

  Object.keys(modes).forEach((mode) => {
    modes[mode] = round2(modes[mode]);
  });

  return {
    sales: round2(sales),
    bills: bills.length,
    averageBill: bills.length ? round2(sales / bills.length) : 0,
    itemsSold: round2(itemsSold),
    discount: round2(discount),
    autoBills,
    autoSales: round2(autoSales),
    manualBills: bills.length - autoBills,
    manualSales: round2(sales - autoSales),
    modes,
  };
};

const rankItems = (bills) => {
  const byKey = new Map();

  bills.forEach((bill) => {
    (bill.items || []).forEach((line) => {
      const key = `${line.productId || line.name}|${line.variant || ""}`;
      const entry = byKey.get(key) || {
        name: line.name,
        variant: line.variant || "",
        category: line.category || "",
        qty: 0,
        amount: 0,
      };
      entry.qty += line.qty;
      entry.amount += line.lineTotal;
      byKey.set(key, entry);
    });
  });

  return [...byKey.values()]
    .map((entry) => ({ ...entry, qty: round2(entry.qty), amount: round2(entry.amount) }))
    .sort((left, right) => right.amount - left.amount);
};

const toBillSummary = (bill) => ({
  id: String(bill._id),
  billNo: bill.billNo,
  billDate: bill.billDate,
  dateKey: bill.dateKey,
  grandTotal: bill.grandTotal,
  itemCount: bill.itemCount,
  paymentMode: bill.paymentMode,
  customerName: bill.customerName,
  source: bill.source,
  status: bill.status,
  itemsLabel: (bill.items || [])
    .map((line) => `${line.qty} × ${line.name}${line.variant ? ` (${line.variant})` : ""}`)
    .join(", "),
});

const toBill = (bill) => ({
  ...toBillSummary(bill),
  items: bill.items,
  subTotal: bill.subTotal,
  discount: bill.discount,
  taxableTotal: bill.taxableTotal,
  cgstTotal: bill.cgstTotal,
  sgstTotal: bill.sgstTotal,
  payments: bill.payments,
  customerPhone: bill.customerPhone,
  note: bill.note,
  cancelReason: bill.cancelReason,
  cancelledAt: bill.cancelledAt,
  createdByName: bill.createdByName,
});

/* ── Catalog & items ────────────────────────────────────────────────────── */

const getCatalog = async (req, res) => {
  try {
    const categories = await ensureDefaultCategories();
    const [catalog, shop] = await Promise.all([
      loadCatalog(categories),
      readShop(),
    ]);
    return res.json({
      items: catalog,
      // Website menu categories, kept for the Items screen.
      categories: [...new Set(catalog.map((item) => item.category))].sort(),
      billingCategories: categories.map((category) => ({
        ...category,
        // Set when the category has no items and is billed as one line.
        isValueCategory: isValueCategory(category),
        allowedValues: isValueCategory(category)
          ? valueCandidates(category)
          : [],
      })),
      shop,
    });
  } catch (error) {
    return fail(res, error, "Error loading billing items");
  }
};

const notifyCatalogChanged = async (action, productId) => {
  // Price and visibility are shared with the website, so its cache must drop.
  await invalidatePublicCache({ action, productId });
  emitSiteDataUpdated("products", { source: "billing" });
  emitAdminDataUpdated("products", { source: "billing" });
};

const updateItem = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw badRequest("Unknown item.");

    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: "Item not found." });
    }

    const { billable, price, gstRate } = req.body || {};

    if (typeof billable === "boolean") {
      product.set("visibility.availableInBilling", billable);
    }

    if (price !== undefined) {
      const hasVariants = toCatalogItem(product.toObject()).hasVariants;
      if (hasVariants) {
        throw badRequest(
          "This item is priced per size. Change its prices from Admin → Products.",
        );
      }
      if (!(Number(price) > 0)) throw badRequest("Price must be above 0.");
      product.price = round2(price);
    }

    if (gstRate !== undefined) {
      if (!(Number(gstRate) >= 0) || Number(gstRate) > 28) {
        throw badRequest("GST rate must be between 0 and 28.");
      }
      product.gstRate = Number(gstRate);
    }

    await product.save();
    await notifyCatalogChanged("billingUpdateItem", String(product._id));

    return res.json({ item: toCatalogItem(product.toObject()) });
  } catch (error) {
    return fail(res, error, "Error updating item");
  }
};

/* A shop-only item (not shown on the website): tea, water bottle, candles… */
const createItem = async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const category = String(req.body?.category || "").trim().toLowerCase();
    const price = round2(req.body?.price);
    const gstRate = req.body?.gstRate === undefined ? 5 : Number(req.body.gstRate);

    if (!name) throw badRequest("Item name is required.");
    if (!category) throw badRequest("Category is required.");
    if (!(price > 0)) throw badRequest("Price must be above 0.");
    if (!(gstRate >= 0) || gstRate > 28) {
      throw badRequest("GST rate must be between 0 and 28.");
    }

    const product = await Product.create({
      name: name.slice(0, 120),
      description: name.slice(0, 120),
      price,
      category,
      image: PLACEHOLDER_IMAGE,
      portionType: "pieces",
      gstRate,
      isEgg: false,
      isEggless: true,
      visibility: {
        showOnWebsite: false,
        allowOnlineOrder: false,
        availableInBilling: true,
        isActive: true,
      },
    });

    await notifyCatalogChanged("billingCreateItem", String(product._id));
    return res.status(201).json({ item: toCatalogItem(product.toObject()) });
  } catch (error) {
    return fail(res, error, "Error adding item");
  }
};

/* ── Bills ──────────────────────────────────────────────────────────────── */

const parsePayments = (input, grandTotal) => {
  const payments = (Array.isArray(input) ? input : [])
    .map((payment) => ({
      mode: String(payment?.mode || "").toLowerCase(),
      amount: round2(payment?.amount),
      reference: String(payment?.reference || "").trim().slice(0, 80),
    }))
    .filter((payment) => payment.amount > 0);

  if (!payments.length) throw badRequest("Add how the bill was paid.");
  if (payments.some((payment) => !PAYMENT_MODES.includes(payment.mode))) {
    throw badRequest("Unknown payment mode.");
  }

  const paid = round2(payments.reduce((sum, payment) => sum + payment.amount, 0));
  if (Math.abs(paid - grandTotal) > 0.009) {
    throw badRequest(`Payments add up to ₹${paid}, but the bill is ₹${grandTotal}.`);
  }

  return payments;
};

const createBill = async (req, res) => {
  try {
    const body = req.body || {};
    const categories = await loadCategories();
    const catalog = await loadCatalog(categories);
    const totals = computeBill(
      resolveLines(body.items, catalog, categories),
      body.discount,
    );

    if (totals.grandTotal <= 0) throw badRequest("Bill total must be above ₹0.");

    const payments = parsePayments(body.payments, totals.grandTotal);
    const now = new Date();
    const dateKey = dateKeyOf(now);
    const [billNo] = await reserveBillNumbers(dateKey, 1);

    const bill = await BillingBill.create({
      ...totals,
      billNo,
      billDate: now,
      dateKey,
      payments,
      paymentMode: summarisePaymentMode(payments),
      customerName: String(body.customerName || "").trim().slice(0, 80),
      customerPhone: String(body.customerPhone || "").trim().slice(0, 20),
      note: String(body.note || "").trim().slice(0, 300),
      source: "manual",
      createdById: req.user.id,
      createdByName: req.user.name || "",
    });

    return res.status(201).json({ bill: toBill(bill.toObject()) });
  } catch (error) {
    return fail(res, error, "Error saving bill");
  }
};

const listBills = async (req, res) => {
  try {
    const { from, to, mode, source, status, q } = req.query;
    const today = dateKeyOf();
    const fromKey = isDateKey(from) ? from : today;
    const toKey = isDateKey(to) ? to : fromKey;

    const query = { dateKey: { $gte: fromKey, $lte: toKey } };
    if (["manual", "auto"].includes(source)) query.source = source;
    if (["active", "cancelled"].includes(status)) query.status = status;
    if ([...PAYMENT_MODES, "split"].includes(mode)) query.paymentMode = mode;

    const search = String(q || "").trim();
    if (search) {
      const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [
        { billNo: pattern },
        { customerName: pattern },
        { customerPhone: pattern },
        { "items.name": pattern },
      ];
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = 50;

    const [bills, total, active] = await Promise.all([
      BillingBill.find(query)
        .sort({ billDate: -1, billNo: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      BillingBill.countDocuments(query),
      BillingBill.find({ ...query, status: query.status || "active" })
        .select("grandTotal discount itemCount source payments status")
        .lean(),
    ]);

    return res.json({
      bills: bills.map(toBillSummary),
      total,
      page,
      pageSize,
      summary: summarise(active.filter((bill) => bill.status === "active")),
    });
  } catch (error) {
    return fail(res, error, "Error loading bills");
  }
};

const getBill = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw badRequest("Unknown bill.");
    const [bill, shop] = await Promise.all([
      BillingBill.findById(req.params.id).lean(),
      readShop(),
    ]);
    if (!bill) return res.status(404).json({ message: "Bill not found." });
    return res.json({ bill: toBill(bill), shop });
  } catch (error) {
    return fail(res, error, "Error loading bill");
  }
};

/* Bills are never deleted — a cancelled bill keeps its number so the series
 * has no gaps, and simply stops counting towards sales. */
const cancelBill = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw badRequest("Unknown bill.");
    const reason = String(req.body?.reason || "").trim().slice(0, 200);
    if (!reason) throw badRequest("Give a reason for cancelling this bill.");

    const bill = await BillingBill.findOneAndUpdate(
      { _id: req.params.id, status: "active" },
      {
        $set: {
          status: "cancelled",
          cancelReason: reason,
          cancelledAt: new Date(),
          cancelledBy: req.user.name || req.user.id,
        },
      },
      { new: true },
    ).lean();

    if (!bill) {
      return res.status(404).json({ message: "Bill not found or already cancelled." });
    }
    return res.json({ bill: toBill(bill) });
  } catch (error) {
    return fail(res, error, "Error cancelling bill");
  }
};

/* ── Dashboard ──────────────────────────────────────────────────────────── */

const getDashboard = async (req, res) => {
  try {
    const dateKey = isDateKey(req.query.date) ? req.query.date : dateKeyOf();
    const weekStart = shiftDateKey(dateKey, -6);
    const monthStart = `${dateKey.slice(0, 7)}-01`;
    const rangeStart = weekStart < monthStart ? weekStart : monthStart;

    const [rangeBills, cancelledToday, recent] = await Promise.all([
      BillingBill.find({
        dateKey: { $gte: rangeStart, $lte: dateKey },
        status: "active",
      }).lean(),
      BillingBill.countDocuments({ dateKey, status: "cancelled" }),
      BillingBill.find({ dateKey }).sort({ billDate: -1 }).limit(8).lean(),
    ]);

    const dayBills = rangeBills.filter((bill) => bill.dateKey === dateKey);
    const yesterdayKey = shiftDateKey(dateKey, -1);

    const trend = Array.from({ length: 7 }, (_, index) => {
      const key = shiftDateKey(weekStart, index);
      const bills = rangeBills.filter((bill) => bill.dateKey === key);
      const totals = summarise(bills);
      return {
        dateKey: key,
        sales: totals.sales,
        bills: totals.bills,
        cash: totals.modes.cash,
        phonepe: totals.modes.phonepe,
      };
    });

    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, sales: 0, bills: 0 }));
    dayBills.forEach((bill) => {
      const hour = Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          hourCycle: "h23",
        }).format(new Date(bill.billDate)),
      );
      hourly[hour].sales = round2(hourly[hour].sales + bill.grandTotal);
      hourly[hour].bills += 1;
    });

    const categoryTotals = new Map();
    dayBills.forEach((bill) => {
      (bill.items || []).forEach((line) => {
        const key = line.category || "other";
        categoryTotals.set(key, (categoryTotals.get(key) || 0) + line.lineTotal);
      });
    });

    return res.json({
      dateKey,
      today: { ...summarise(dayBills), cancelled: cancelledToday },
      yesterday: summarise(
        rangeBills.filter((bill) => bill.dateKey === yesterdayKey),
      ),
      monthToDate: summarise(
        rangeBills.filter((bill) => bill.dateKey >= monthStart),
      ),
      trend,
      hourly: hourly.filter((slot) => slot.bills > 0),
      topItems: rankItems(dayBills).slice(0, 8),
      categories: [...categoryTotals.entries()]
        .map(([category, amount]) => ({ category, amount: round2(amount) }))
        .sort((left, right) => right.amount - left.amount),
      recentBills: recent.map(toBillSummary),
    });
  } catch (error) {
    return fail(res, error, "Error loading billing dashboard");
  }
};

/* ── Billing categories ─────────────────────────────────────────────────── */

// The shop's standard list, used once to fill an empty Categories & Tax page.
const DEFAULT_CATEGORIES = [
  ["Bread", "1905", 0],
  ["Biscuit / Cookie", "1905", 5],
  ["Rusk", "1905", 5],
  ["Puffs", "1905", 5],
  ["Confectionery", "1704", 5],
  ["Namkeen / Chips", "2106", 5],
  ["Ice Cream", "2105", 5],
  ["Cakes / Pastries", "1905", 5],
  ["Chocolates", "1806", 5],
  ["Decoration Items", "9503", 18],
  ["Cheese", "0406", 12],
  ["Butter", "0405", 12],
  ["Green Peas / Sweet Corn", "0710", 0],
  ["Fruit Drinks", "2202", 5],
  ["Drinking Water", "2201", 5],
  ["Aerated / Soft Drinks", "2202", 40],
];

async function ensureDefaultCategories() {
  const existing = await BillingCategory.estimatedDocumentCount();
  if (existing === 0) {
    await BillingCategory.insertMany(
      DEFAULT_CATEGORIES.map(([name, hsnCode, gstRate], index) => ({
        name,
        hsnCode,
        gstRate,
        sortOrder: index + 1,
      })),
      { ordered: false },
    ).catch((error) => {
      // Another request seeded at the same moment; harmless.
      logger.warn("Billing category seed skipped", { error: error.message });
    });
  }
  return loadCategories();
}

const parseCategoryBody = (body, { partial = false } = {}) => {
  const update = {};

  if (!partial || body.name !== undefined) {
    const name = String(body.name || "").trim();
    if (!name) throw badRequest("Category name is required.");
    update.name = name.slice(0, 80);
  }

  if (body.hsnCode !== undefined) {
    const hsnCode = String(body.hsnCode || "").trim();
    if (hsnCode && !/^\d{2,8}$/.test(hsnCode)) {
      throw badRequest("HSN code must be 2 to 8 digits.");
    }
    update.hsnCode = hsnCode;
  }

  if (body.gstRate !== undefined) {
    const gstRate = Number(body.gstRate);
    if (!(gstRate >= 0) || gstRate > 100) {
      throw badRequest("GST % must be between 0 and 100.");
    }
    update.gstRate = gstRate;
  }

  if (body.sortOrder !== undefined) {
    update.sortOrder = Number(body.sortOrder) || 0;
  }

  if (body.productIds !== undefined) {
    update.productIds = [
      ...new Set(
        (Array.isArray(body.productIds) ? body.productIds : [])
          .map(String)
          .filter((id) => mongoose.isValidObjectId(id)),
      ),
    ];
  }

  if (body.valueMode !== undefined) {
    const valueMode = String(body.valueMode);
    if (!["none", "fixed", "range"].includes(valueMode)) {
      throw badRequest("Unknown pricing choice for the category.");
    }
    update.valueMode = valueMode;

    if (valueMode === "fixed") {
      const values = [
        ...new Set(
          (Array.isArray(body.fixedValues) ? body.fixedValues : []).map(Number),
        ),
      ].sort((left, right) => left - right);
      if (!values.length) {
        throw badRequest("Enter at least one fixed amount.");
      }
      if (values.some((value) => !Number.isInteger(value) || value <= 0)) {
        throw badRequest("Fixed amounts must be whole rupees above 0.");
      }
      update.fixedValues = values;
    }

    if (valueMode === "range") {
      const rangeMin = Number(body.rangeMin);
      const rangeMax = Number(body.rangeMax);
      const roundTo = Number(body.roundTo || 1);
      if (!Number.isInteger(rangeMin) || !Number.isInteger(rangeMax)) {
        throw badRequest("Range amounts must be whole rupees.");
      }
      if (rangeMin <= 0 || rangeMax < rangeMin) {
        throw badRequest("The range needs a lowest amount above 0 and a highest amount at or above it.");
      }
      if (!Number.isInteger(roundTo) || roundTo < 1) {
        throw badRequest("Round-off must be a whole number such as 1, 5 or 10.");
      }
      const endDigits = [
        ...new Set(
          (Array.isArray(body.endDigits) ? body.endDigits : []).map(Number),
        ),
      ].sort((left, right) => left - right);
      if (endDigits.some((digit) => !Number.isInteger(digit) || digit < 0 || digit > 9)) {
        throw badRequest("Last digits must be between 0 and 9.");
      }
      const candidate = { valueMode: "range", rangeMin, rangeMax, roundTo, endDigits };
      if (!valueCandidates(candidate).length) {
        throw badRequest(
          endDigits.length
            ? `No amount between ₹${rangeMin} and ₹${rangeMax} ends in ${endDigits.join(" or ")}.`
            : `No multiple of ${roundTo} lies between ₹${rangeMin} and ₹${rangeMax}.`,
        );
      }
      update.rangeMin = rangeMin;
      update.rangeMax = rangeMax;
      update.roundTo = roundTo;
      update.endDigits = endDigits;
    }
  }

  return update;
};

const duplicateName = (error) =>
  error?.code === 11000
    ? badRequest("A category with that name already exists.")
    : error;

/* An item belongs to one billing category: placing it here takes it out of
 * wherever it was. */
const releaseFromOtherCategories = (categoryId, productIds) =>
  productIds?.length
    ? BillingCategory.updateMany(
        { _id: { $ne: categoryId } },
        { $pull: { productIds: { $in: productIds } } },
      )
    : Promise.resolve();

const listCategories = async (req, res) => {
  try {
    return res.json({ categories: await ensureDefaultCategories() });
  } catch (error) {
    return fail(res, error, "Error loading categories");
  }
};

const createCategory = async (req, res) => {
  try {
    const data = parseCategoryBody(req.body || {});
    const last = await BillingCategory.findOne({}).sort({ sortOrder: -1 }).lean();
    const category = await BillingCategory.create({
      ...data,
      sortOrder: data.sortOrder || Number(last?.sortOrder || 0) + 1,
    }).catch((error) => {
      throw duplicateName(error);
    });
    await releaseFromOtherCategories(category._id, data.productIds);
    return res.status(201).json({ category: toCategory(category.toObject()) });
  } catch (error) {
    return fail(res, error, "Error adding category");
  }
};

const updateCategory = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw badRequest("Unknown category.");
    }
    const data = parseCategoryBody(req.body || {}, { partial: true });
    const category = await BillingCategory.findByIdAndUpdate(
      req.params.id,
      { $set: data },
      { new: true, runValidators: true },
    )
      .lean()
      .catch((error) => {
        throw duplicateName(error);
      });
    if (!category) {
      return res.status(404).json({ message: "Category not found." });
    }
    await releaseFromOtherCategories(category._id, data.productIds);
    return res.json({ category: toCategory(category) });
  } catch (error) {
    return fail(res, error, "Error updating category");
  }
};

/* Deleting a category leaves its items uncategorised. Bills already saved
 * keep the category name, HSN code and GST they were billed with. */
const deleteCategory = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw badRequest("Unknown category.");
    }
    const category = await BillingCategory.findByIdAndDelete(req.params.id).lean();
    if (!category) {
      return res.status(404).json({ message: "Category not found." });
    }
    return res.json({ deleted: true, name: category.name });
  } catch (error) {
    return fail(res, error, "Error deleting category");
  }
};

/* ── Reports ────────────────────────────────────────────────────────────── */

const getReport = async (req, res) => {
  try {
    const today = dateKeyOf();
    const toKey = isDateKey(req.query.to) ? req.query.to : today;
    const fromKey = isDateKey(req.query.from)
      ? req.query.from
      : `${toKey.slice(0, 7)}-01`;
    if (fromKey > toKey) throw badRequest("The start date is after the end date.");

    const [bills, cancelled] = await Promise.all([
      BillingBill.find({
        dateKey: { $gte: fromKey, $lte: toKey },
        status: "active",
      }).lean(),
      BillingBill.find({
        dateKey: { $gte: fromKey, $lte: toKey },
        status: "cancelled",
      })
        .select("grandTotal")
        .lean(),
    ]);

    const byDayMap = new Map();
    bills.forEach((bill) => {
      const list = byDayMap.get(bill.dateKey) || [];
      list.push(bill);
      byDayMap.set(bill.dateKey, list);
    });

    const byDay = [...byDayMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([dateKey, dayBills]) => {
        const totals = summarise(dayBills);
        return {
          dateKey,
          sales: totals.sales,
          bills: totals.bills,
          cash: totals.modes.cash,
          phonepe: totals.modes.phonepe,
          card: totals.modes.card,
          other: totals.modes.other,
          discount: totals.discount,
        };
      });

    /* Every line is counted at what the customer actually paid for it (after
     * any bill discount), and split between cash and UPI in the proportion
     * the bill itself was paid — so the category and item totals add up to
     * the sales figure. */
    const categoryMap = new Map();
    const itemMap = new Map();
    const gstMap = new Map();

    const addTo = (entry, qty, amount, cash, upi) => {
      entry.qty += qty;
      entry.amount += amount;
      entry.cash += cash;
      entry.upi += upi;
    };

    bills.forEach((bill) => {
      const paidBy = (mode) =>
        (bill.payments || [])
          .filter((payment) => payment.mode === mode)
          .reduce((sum, payment) => sum + payment.amount, 0);
      const cashShare = bill.grandTotal > 0 ? paidBy("cash") / bill.grandTotal : 0;
      const upiShare = bill.grandTotal > 0 ? paidBy("phonepe") / bill.grandTotal : 0;
      const factor = bill.subTotal > 0 ? bill.grandTotal / bill.subTotal : 0;

      (bill.items || []).forEach((line) => {
        const amount = line.lineTotal * factor;
        const cash = amount * cashShare;
        const upi = amount * upiShare;
        const categoryName = line.category || UNCATEGORISED;

        const category = categoryMap.get(categoryName) || {
          category: categoryName,
          hsnCode: line.hsnCode || "",
          gstRate: Number(line.gstRate || 0),
          qty: 0,
          amount: 0,
          cash: 0,
          upi: 0,
          items: new Map(),
        };
        addTo(category, line.qty, amount, cash, upi);
        categoryMap.set(categoryName, category);

        const itemKey = `${line.productId || line.name}|${line.variant || ""}`;
        const newItem = () => ({
          name: line.name,
          variant: line.variant || "",
          category: categoryName,
          qty: 0,
          amount: 0,
          cash: 0,
          upi: 0,
        });

        const inCategory = category.items.get(itemKey) || newItem();
        addTo(inCategory, line.qty, amount, cash, upi);
        category.items.set(itemKey, inCategory);

        const flatKey = `${categoryName}|${itemKey}`;
        const flat = itemMap.get(flatKey) || newItem();
        addTo(flat, line.qty, amount, cash, upi);
        itemMap.set(flatKey, flat);

        const gstKey = `${line.hsnCode || ""}|${Number(line.gstRate || 0)}`;
        const gst = gstMap.get(gstKey) || {
          hsnCode: line.hsnCode || "",
          rate: Number(line.gstRate || 0),
          taxable: 0,
          cgst: 0,
          sgst: 0,
        };
        gst.taxable += line.taxableValue || 0;
        gst.cgst += line.cgst || 0;
        gst.sgst += line.sgst || 0;
        gstMap.set(gstKey, gst);
      });
    });

    const tidy = (entry) => ({
      ...entry,
      qty: round2(entry.qty),
      amount: round2(entry.amount),
      cash: round2(entry.cash),
      upi: round2(entry.upi),
    });
    const byAmount = (left, right) => right.amount - left.amount;

    return res.json({
      from: fromKey,
      to: toKey,
      totals: summarise(bills),
      cancelled: {
        bills: cancelled.length,
        amount: round2(cancelled.reduce((sum, bill) => sum + bill.grandTotal, 0)),
      },
      byDay,
      categories: [...categoryMap.values()]
        .map((category) => ({
          ...tidy(category),
          items: [...category.items.values()].map(tidy).sort(byAmount),
        }))
        .sort(byAmount),
      items: [...itemMap.values()].map(tidy).sort(byAmount),
      gst: [...gstMap.values()]
        .map((entry) => ({
          hsnCode: entry.hsnCode,
          rate: entry.rate,
          taxable: round2(entry.taxable),
          cgst: round2(entry.cgst),
          sgst: round2(entry.sgst),
          total: round2(entry.taxable + entry.cgst + entry.sgst),
        }))
        .sort(
          (left, right) =>
            left.rate - right.rate || left.hsnCode.localeCompare(right.hsnCode),
        ),
    });
  } catch (error) {
    return fail(res, error, "Error loading report");
  }
};

/* ── Auto billing ───────────────────────────────────────────────────────── */

const parseAmount = (value, label) => {
  const amount = round2(value);
  if (!(amount > 0)) throw badRequest(`${label} must be above ₹0.`);
  if (amount > MAX_BILL_AMOUNT) {
    throw badRequest(
      `${label} of ₹${amount} is above the ₹${MAX_BILL_AMOUNT} per-bill limit.`,
    );
  }
  return amount;
};

const parseAutoRequest = (body) => {
  const date = isDateKey(body.date) ? body.date : null;
  if (!date) throw badRequest("Pick the date these takings are for.");
  if (date > dateKeyOf()) {
    throw badRequest("Auto billing cannot be run for a future date.");
  }

  const phonepe = (Array.isArray(body.phonepe) ? body.phonepe : []).map(
    (entry, index) => ({
      amount: parseAmount(entry?.amount, `PhonePe transaction ${index + 1}`),
      time: isTime(entry?.time) ? entry.time : "",
      reference: String(entry?.reference || "").trim().slice(0, 80),
    }),
  );
  const upiTotal = round2(phonepe.reduce((sum, entry) => sum + entry.amount, 0));

  // The cash can be typed directly, or worked out from the day's total.
  const amount = round2(body.amount);
  if (!(amount >= 0)) throw badRequest("Enter the cash amount or the day's total.");
  const cashTotal =
    body.amountMode === "total" ? round2(amount - upiTotal) : amount;
  if (cashTotal < 0) {
    throw badRequest(
      `The day's total of ₹${amount} is less than the PhonePe total of ₹${upiTotal}.`,
    );
  }
  if (!Number.isInteger(cashTotal)) {
    throw badRequest(
      `The cash works out to ₹${cashTotal}; it must be a whole number of rupees.`,
    );
  }
  if (cashTotal > 1000000) throw badRequest("The cash amount is too large for one run.");
  if (!phonepe.length && !cashTotal) {
    throw badRequest("Add PhonePe transactions or a cash amount.");
  }

  const totalBills = Number(body.totalBills);
  if (!Number.isInteger(totalBills) || totalBills < 1) {
    throw badRequest("Enter how many bills the day should have.");
  }

  const seen = new Set();
  const categoryTargets = (
    Array.isArray(body.categoryTargets) ? body.categoryTargets : []
  )
    .filter((target) => Number(target?.amount) > 0)
    .map((target) => {
      const categoryId = String(target.categoryId || "");
      const targetAmount = Number(target.amount);
      if (!Number.isInteger(targetAmount)) {
        throw badRequest("Category amounts must be whole rupees.");
      }
      if (seen.has(categoryId)) {
        throw badRequest("A category has been given an amount twice.");
      }
      seen.add(categoryId);
      return { categoryId, amount: targetAmount };
    });

  const input = body.options || {};
  const options = {
    startTime: isTime(input.startTime) ? input.startTime : "09:00",
    endTime: isTime(input.endTime) ? input.endTime : "22:00",
    maxQtyPerItem: Number(input.maxQtyPerItem) || undefined,
    // Category whose open line covers amounts the prices cannot make.
    gapCategoryId: String(input.gapCategoryId || ""),
  };
  if (options.endTime <= options.startTime) {
    throw badRequest("Shop closing time must be after opening time.");
  }

  return { date, phonepe, cashTotal, totalBills, categoryTargets, options };
};

const existingForDate = async (dateKey) => {
  const bills = await BillingBill.find({ dateKey, status: "active" })
    .select("grandTotal discount itemCount source payments")
    .lean();
  return summarise(bills);
};

const previewAutoBills = async (req, res) => {
  try {
    const request = parseAutoRequest(req.body || {});
    const categories = await loadCategories();
    const [catalog, existing] = await Promise.all([
      loadCatalog(categories),
      existingForDate(request.date),
    ]);

    const plan = generatePlan({ catalog, categories, ...request });

    return res.json({ date: request.date, ...plan, existing });
  } catch (error) {
    return fail(res, error, "Error generating bills");
  }
};

const commitAutoBills = async (req, res) => {
  try {
    const body = req.body || {};
    const date = isDateKey(body.date) ? body.date : null;
    if (!date) throw badRequest("Pick the date these bills are for.");
    if (date > dateKeyOf()) {
      throw badRequest("Bills cannot be saved for a future date.");
    }

    const drafts = Array.isArray(body.bills) ? body.bills : [];
    if (!drafts.length) throw badRequest("There are no bills to save.");
    if (drafts.length > MAX_BILLS) {
      throw badRequest(`At most ${MAX_BILLS} bills can be saved in one run.`);
    }

    const categories = await loadCategories();
    const catalog = await loadCatalog(categories);

    // Re-price every bill from the catalog; the client's numbers are not
    // trusted. The items must add up to the money received, to the rupee.
    const prepared = drafts.map((draft, index) => {
      const label = `Bill ${index + 1}`;
      const mode = String(draft?.mode || "").toLowerCase();
      if (!["cash", "phonepe"].includes(mode)) {
        throw badRequest(`${label}: unknown payment mode.`);
      }

      const amount = parseAmount(draft?.amount, label);
      const lines = resolveLines(draft?.lines, catalog, categories, {
        strictValues: true,
      });
      const totals = computeBill(lines, 0);

      if (Math.abs(totals.grandTotal - amount) > 0.009) {
        throw badRequest(
          `${label}: the items come to ₹${totals.grandTotal} but ₹${amount} was received. Generate again to fix it.`,
        );
      }

      return {
        totals,
        mode,
        amount,
        time: isTime(draft?.time) ? draft.time : "12:00",
        reference: String(draft?.reference || "").trim().slice(0, 80),
      };
    });

    prepared.sort((left, right) => left.time.localeCompare(right.time));

    const billNumbers = await reserveBillNumbers(date, prepared.length);
    const autoBatchId = `auto-${date}-${Date.now()}`;

    const documents = prepared.map((entry, index) => ({
      ...entry.totals,
      billNo: billNumbers[index],
      billDate: istDate(date, entry.time),
      dateKey: date,
      payments: [
        { mode: entry.mode, amount: entry.amount, reference: entry.reference },
      ],
      paymentMode: entry.mode,
      source: "auto",
      autoBatchId,
      createdById: req.user.id,
      createdByName: req.user.name || "",
    }));

    await BillingBill.insertMany(documents);

    logger.info("Auto billing committed", {
      date,
      autoBatchId,
      bills: documents.length,
      userId: req.user.id,
    });

    return res.status(201).json({
      autoBatchId,
      saved: documents.length,
      total: round2(documents.reduce((sum, bill) => sum + bill.grandTotal, 0)),
      firstBillNo: billNumbers[0],
      lastBillNo: billNumbers[billNumbers.length - 1],
    });
  } catch (error) {
    return fail(res, error, "Error saving generated bills");
  }
};

/* Reverses a whole auto-billing run (e.g. the wrong date was picked). */
const cancelAutoBatch = async (req, res) => {
  try {
    const autoBatchId = String(req.params.batchId || "");
    if (!autoBatchId.startsWith("auto-")) {
      throw badRequest("Unknown auto-billing run.");
    }

    const result = await BillingBill.updateMany(
      { autoBatchId, status: "active" },
      {
        $set: {
          status: "cancelled",
          cancelReason: "Auto-billing run reversed",
          cancelledAt: new Date(),
          cancelledBy: req.user.name || req.user.id,
        },
      },
    );

    return res.json({ cancelled: result.modifiedCount || 0 });
  } catch (error) {
    return fail(res, error, "Error reversing auto-billing run");
  }
};

const listAutoBatches = async (req, res) => {
  try {
    const batches = await BillingBill.aggregate([
      { $match: { source: "auto" } },
      {
        $group: {
          _id: "$autoBatchId",
          dateKey: { $first: "$dateKey" },
          createdAt: { $min: "$createdAt" },
          createdByName: { $first: "$createdByName" },
          bills: { $sum: 1 },
          activeBills: {
            $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] },
          },
          total: { $sum: "$grandTotal" },
        },
      },
      { $sort: { createdAt: -1 } },
      { $limit: 20 },
    ]);

    return res.json({
      batches: batches.map((batch) => ({
        id: batch._id,
        dateKey: batch.dateKey,
        createdAt: batch.createdAt,
        createdByName: batch.createdByName,
        bills: batch.bills,
        activeBills: batch.activeBills,
        total: round2(batch.total),
      })),
    });
  } catch (error) {
    return fail(res, error, "Error loading auto-billing runs");
  }
};

module.exports = {
  getCatalog,
  updateItem,
  createItem,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  createBill,
  listBills,
  getBill,
  cancelBill,
  getDashboard,
  getReport,
  previewAutoBills,
  commitAutoBills,
  cancelAutoBatch,
  listAutoBatches,
};
