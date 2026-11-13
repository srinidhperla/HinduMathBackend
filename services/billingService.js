const Product = require("../models/Product");
const Counter = require("../models/Counter");
const BillingCategory = require("../models/BillingCategory");

/* Shared helpers for the counter-billing module (/api/billing):
 *   - IST date handling (the shop's day, not the server's)
 *   - billing categories (HSN code + GST slab) and the billing catalog
 *   - bill arithmetic (GST-inclusive prices, bill-level discount)
 *   - bill numbering
 */

const IST_OFFSET = "+05:30";
const PAYMENT_MODES = ["cash", "phonepe", "card", "other"];
const UNCATEGORISED = "Uncategorised";

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

const fail = (message, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });

const dateKeyOf = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

const isDateKey = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
const isTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));

const istDate = (dateKey, time = "00:00") =>
  new Date(`${dateKey}T${time}:00${IST_OFFSET}`);

const shiftDateKey = (dateKey, days) => {
  const date = istDate(dateKey, "12:00");
  date.setUTCDate(date.getUTCDate() + days);
  return dateKeyOf(date);
};

/* ── Billing categories ─────────────────────────────────────────────────── */

const toCategory = (category) => ({
  id: String(category._id),
  name: category.name,
  hsnCode: category.hsnCode || "",
  gstRate: Number(category.gstRate || 0),
  sortOrder: Number(category.sortOrder || 0),
  productIds: (category.productIds || []).map(String),
  valueMode: category.valueMode || "none",
  fixedValues: (category.fixedValues || []).map(Number),
  rangeMin: Number(category.rangeMin || 0),
  rangeMax: Number(category.rangeMax || 0),
  roundTo: Math.max(1, Number(category.roundTo || 1)),
  endDigits: [...new Set((category.endDigits || []).map(Number))]
    .filter((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9)
    .sort((left, right) => left - right),
});

/* Whether a whole-rupee amount fits a range category's rounding: its last
 * digit is one of the chosen ones, or (older categories) it is a multiple of
 * the round-off step. */
const fitsRangeRounding = (category, value) => {
  if (category.endDigits && category.endDigits.length) {
    return (
      Number.isInteger(value) && category.endDigits.includes(value % 10)
    );
  }
  const step = Math.max(1, Math.round(category.roundTo || 1));
  return step <= 1 || Math.abs(value / step - Math.round(value / step)) < 1e-6;
};

const loadCategories = async () => {
  const categories = await BillingCategory.find({})
    .sort({ sortOrder: 1, name: 1 })
    .lean();
  return categories.map(toCategory);
};

/* A category with no items is billed as a single line named after it, priced
 * from its fixed values or range. */
const isValueCategory = (category) =>
  category.productIds.length === 0 && category.valueMode !== "none";

/* Every amount a value category may be billed at. Capped so a wide range
 * with a small step cannot produce an enormous list. */
const MAX_VALUE_CANDIDATES = 500;

const valueCandidates = (category) => {
  if (category.valueMode === "fixed") {
    return [...new Set(category.fixedValues)]
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((left, right) => left - right);
  }

  if (category.valueMode === "range") {
    const values = [];
    for (
      let value = Math.max(1, Math.ceil(category.rangeMin));
      value <= category.rangeMax && values.length < MAX_VALUE_CANDIDATES;
      value += 1
    ) {
      if (fitsRangeRounding(category, value)) values.push(value);
    }
    return values;
  }

  return [];
};

const isAllowedValue = (category, price) => {
  if (category.valueMode === "fixed") {
    return category.fixedValues.some((value) => Math.abs(value - price) < 0.005);
  }
  if (category.valueMode === "range") {
    if (price < category.rangeMin - 0.005 || price > category.rangeMax + 0.005) {
      return false;
    }
    const rupees = Math.round(price);
    if (Math.abs(price - rupees) > 0.005) {
      return !category.endDigits.length && Math.max(1, category.roundTo || 1) <= 1;
    }
    return fitsRangeRounding(category, rupees);
  }
  return false;
};

/* ── Catalog ──────────────────────────────────────────────────────────────
 * The website prices cakes per egg type and weight in `variantPrices`
 * ({ "egg::Cake": { "500g": 370 } }). The counter sells exactly those, so a
 * product becomes one catalog item with one variant per priced combination.
 * A product with no variant prices is a single variant at `price`.
 *
 * An item placed in a billing category takes that category's HSN code and
 * GST rate; its own older rate is only used while it is uncategorised. */

const eggLabel = (typeKey) =>
  String(typeKey).toLowerCase().startsWith("eggless") ? "Eggless" : "Egg";

const toCatalogItem = (product, categoryByProductId = new Map()) => {
  const visibility = product.visibility || {};
  const variantPrices =
    product.variantPrices instanceof Map
      ? Object.fromEntries(product.variantPrices)
      : product.variantPrices || {};

  const typeKeys = Object.keys(variantPrices).filter(
    (typeKey) =>
      variantPrices[typeKey] && typeof variantPrices[typeKey] === "object",
  );
  const variants = [];

  typeKeys.forEach((typeKey) => {
    Object.entries(variantPrices[typeKey]).forEach(([weight, price]) => {
      if (!(Number(price) > 0)) return;
      variants.push({
        key: `${typeKey}|${weight}`,
        label:
          typeKeys.length > 1 ? `${weight} · ${eggLabel(typeKey)}` : weight,
        price: Number(price),
      });
    });
  });

  const hasVariants = variants.length > 0;
  if (!hasVariants) {
    variants.push({ key: "", label: "", price: Number(product.price || 0) });
  }

  const id = String(product._id);
  const billingCategory = categoryByProductId.get(id) || null;

  return {
    id,
    name: product.name,
    // Website menu category — shown for reference only.
    category: product.category || "",
    billingCategoryId: billingCategory ? billingCategory.id : "",
    billingCategory: billingCategory ? billingCategory.name : "",
    image: product.image || "",
    price: Number(product.price || 0),
    gstRate: billingCategory
      ? billingCategory.gstRate
      : Number(product.gstRate ?? 5),
    hsnCode: billingCategory ? billingCategory.hsnCode : product.hsnCode || "",
    isAddon: Boolean(product.isAddon),
    hasVariants,
    variants,
    billable:
      visibility.availableInBilling !== false && visibility.isActive !== false,
    showOnWebsite:
      visibility.showOnWebsite !== false && visibility.isActive !== false,
  };
};

const indexCategoriesByProduct = (categories) => {
  const byProductId = new Map();
  categories.forEach((category) => {
    category.productIds.forEach((productId) => {
      byProductId.set(productId, category);
    });
  });
  return byProductId;
};

const loadCatalog = async (categories) => {
  const [products, billingCategories] = await Promise.all([
    Product.find({}).sort({ category: 1, displayOrder: 1, name: 1 }).lean(),
    categories ? Promise.resolve(categories) : loadCategories(),
  ]);
  const byProductId = indexCategoriesByProduct(billingCategories);
  return products.map((product) => toCatalogItem(product, byProductId));
};

/* Turns client lines into priced bill lines. Three kinds of line:
 *   { productId, variantKey, qty }      an item — price comes from the catalog
 *   { categoryId, unitPrice, qty }      a category line (category has no items)
 *   { name, unitPrice, qty }            a one-off custom line
 * `strictValues` makes a category line obey the category's fixed values or
 * range; auto billing always uses it. */
const resolveLines = (
  inputLines,
  catalog,
  categories = [],
  { strictValues = false } = {},
) => {
  const itemsById = new Map(catalog.map((item) => [item.id, item]));
  const categoriesById = new Map(
    categories.map((category) => [category.id, category]),
  );
  const lines = [];

  (Array.isArray(inputLines) ? inputLines : []).forEach((input) => {
    const qty = Number(input?.qty);
    if (!(qty > 0) || qty > 9999) {
      throw fail("Each line needs a quantity above 0.");
    }

    if (input.productId) {
      const item = itemsById.get(String(input.productId));
      if (!item || !item.billable) {
        throw fail(
          `"${input.name || input.productId}" is not available for billing.`,
        );
      }

      const variant =
        item.variants.find(
          (entry) => entry.key === String(input.variantKey || ""),
        ) || (item.variants.length === 1 ? item.variants[0] : null);
      if (!variant) {
        throw fail(`Pick a size for "${item.name}".`);
      }

      lines.push({
        productId: item.id,
        categoryId: item.billingCategoryId,
        name: item.name,
        variant: variant.label,
        category: item.billingCategory || UNCATEGORISED,
        hsnCode: item.hsnCode,
        qty,
        unitPrice: variant.price,
        gstRate: item.gstRate,
      });
      return;
    }

    const unitPrice = round2(input.unitPrice);

    if (input.categoryId) {
      const category = categoriesById.get(String(input.categoryId));
      if (!category) {
        throw fail("That category no longer exists.");
      }
      if (!(unitPrice > 0)) {
        throw fail(`Enter an amount for "${category.name}".`);
      }

      /* An open line: a named item at any price, billed under this category's
       * HSN code and GST rate. Used for an item typed in by hand, and for
       * the gap-filler line auto billing adds when prices cannot make an
       * amount. Not limited to the category's fixed values or range. */
      if (input.open) {
        const openName = String(input.name || category.name).trim();
        lines.push({
          productId: "",
          categoryId: category.id,
          name: (openName || category.name).slice(0, 120),
          variant: "",
          category: category.name,
          hsnCode: category.hsnCode,
          qty,
          unitPrice,
          gstRate: category.gstRate,
        });
        return;
      }

      if (strictValues && !isAllowedValue(category, unitPrice)) {
        throw fail(
          `₹${unitPrice} is not one of the amounts allowed for "${category.name}".`,
        );
      }

      lines.push({
        productId: "",
        categoryId: category.id,
        name: category.name,
        variant: "",
        category: category.name,
        hsnCode: category.hsnCode,
        qty,
        unitPrice,
        gstRate: category.gstRate,
      });
      return;
    }

    const name = String(input.name || "").trim();
    if (!name || !(unitPrice > 0)) {
      throw fail("A custom item needs a name and a price.");
    }
    lines.push({
      productId: "",
      categoryId: "",
      name: name.slice(0, 120),
      variant: "",
      category: UNCATEGORISED,
      hsnCode: "",
      qty,
      unitPrice,
      gstRate: Number.isFinite(Number(input.gstRate))
        ? Math.max(0, Number(input.gstRate))
        : 5,
    });
  });

  if (!lines.length) {
    throw fail("Add at least one item to the bill.");
  }

  return lines;
};

/* Prices are GST-inclusive. A bill-level discount is spread across lines in
 * proportion to their value so the tax on each line stays correct. */
const computeBill = (lines, discountInput = 0) => {
  const priced = lines.map((line) => ({
    ...line,
    lineTotal: round2(line.qty * line.unitPrice),
  }));
  const subTotal = round2(priced.reduce((sum, line) => sum + line.lineTotal, 0));
  const discount = Math.min(subTotal, Math.max(0, round2(discountInput)));
  const factor = subTotal > 0 ? (subTotal - discount) / subTotal : 0;

  let taxableTotal = 0;
  let gstTotal = 0;

  const items = priced.map((line) => {
    const net = line.lineTotal * factor;
    const taxable = net / (1 + (line.gstRate || 0) / 100);
    const gst = net - taxable;
    taxableTotal += taxable;
    gstTotal += gst;
    return {
      ...line,
      taxableValue: round2(taxable),
      cgst: round2(gst / 2),
      sgst: round2(gst / 2),
    };
  });

  return {
    items,
    itemCount: round2(items.reduce((sum, line) => sum + line.qty, 0)),
    subTotal,
    discount,
    taxableTotal: round2(taxableTotal),
    cgstTotal: round2(gstTotal / 2),
    sgstTotal: round2(gstTotal / 2),
    grandTotal: round2(subTotal - discount),
  };
};

/* Bill numbers run per financial year (April–March): HB-2627-00042. One
 * atomic $inc reserves `count` consecutive numbers. */
const financialYearOf = (dateKey) => {
  const [year, month] = dateKey.split("-").map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${String(start).slice(-2)}${String(start + 1).slice(-2)}`;
};

const reserveBillNumbers = async (dateKey, count = 1) => {
  const fy = financialYearOf(dateKey);
  const counter = await Counter.findOneAndUpdate(
    { _id: `billing-bill-${fy}` },
    { $inc: { seq: count } },
    { new: true, upsert: true },
  );
  const first = counter.seq - count + 1;
  return Array.from(
    { length: count },
    (_, index) => `HB-${fy}-${String(first + index).padStart(5, "0")}`,
  );
};

const summarisePaymentMode = (payments) => {
  const modes = [...new Set(payments.map((payment) => payment.mode))];
  return modes.length === 1 ? modes[0] : "split";
};

module.exports = {
  PAYMENT_MODES,
  UNCATEGORISED,
  round2,
  fail,
  dateKeyOf,
  isDateKey,
  isTime,
  istDate,
  shiftDateKey,
  toCategory,
  loadCategories,
  isValueCategory,
  valueCandidates,
  isAllowedValue,
  loadCatalog,
  toCatalogItem,
  indexCategoriesByProduct,
  resolveLines,
  computeBill,
  reserveBillNumbers,
  summarisePaymentMode,
};
