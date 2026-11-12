const Product = require("../models/Product");
const Counter = require("../models/Counter");

/* Shared helpers for the counter-billing module (/api/billing):
 *   - IST date handling (the shop's day, not the server's)
 *   - the billing catalog: products flattened into sellable variants
 *   - bill arithmetic (GST-inclusive prices, bill-level discount)
 *   - bill numbering
 */

const IST_OFFSET = "+05:30";
const PAYMENT_MODES = ["cash", "phonepe", "card", "other"];

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

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

/* ── Catalog ──────────────────────────────────────────────────────────────
 * The website prices cakes per egg type and weight in `variantPrices`
 * ({ "egg::Cake": { "500g": 370 } }). The counter sells exactly those, so a
 * product becomes one catalog item with one variant per priced combination.
 * A product with no variant prices is a single variant at `price`. */

const eggLabel = (typeKey) =>
  String(typeKey).toLowerCase().startsWith("eggless") ? "Eggless" : "Egg";

const toCatalogItem = (product) => {
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

  return {
    id: String(product._id),
    name: product.name,
    category: product.category || "",
    image: product.image || "",
    price: Number(product.price || 0),
    gstRate: Number(product.gstRate ?? 5),
    hsnCode: product.hsnCode || "",
    isAddon: Boolean(product.isAddon),
    hasVariants,
    variants,
    billable:
      visibility.availableInBilling !== false && visibility.isActive !== false,
    showOnWebsite:
      visibility.showOnWebsite !== false && visibility.isActive !== false,
  };
};

const loadCatalog = async () => {
  const products = await Product.find({})
    .sort({ category: 1, displayOrder: 1, name: 1 })
    .lean();
  return products.map(toCatalogItem);
};

/* Turns client lines ({ productId, variantKey, qty }) into priced bill lines.
 * Prices always come from the catalog — the client never sets them — except
 * for an open "custom" line (no productId), used for one-off cake orders. */
const resolveLines = (inputLines, catalog) => {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const lines = [];

  (Array.isArray(inputLines) ? inputLines : []).forEach((input) => {
    const qty = Number(input?.qty);
    if (!(qty > 0) || qty > 9999) {
      throw Object.assign(new Error("Each line needs a quantity above 0."), {
        statusCode: 400,
      });
    }

    if (!input.productId) {
      const name = String(input.name || "").trim();
      const unitPrice = round2(input.unitPrice);
      if (!name || !(unitPrice > 0)) {
        throw Object.assign(
          new Error("A custom item needs a name and a price."),
          { statusCode: 400 },
        );
      }
      lines.push({
        productId: "",
        name: name.slice(0, 120),
        variant: "",
        category: "custom",
        hsnCode: "1905",
        qty,
        unitPrice,
        gstRate: Number.isFinite(Number(input.gstRate))
          ? Math.max(0, Number(input.gstRate))
          : 5,
      });
      return;
    }

    const item = byId.get(String(input.productId));
    if (!item || !item.billable) {
      throw Object.assign(
        new Error(`"${input.name || input.productId}" is not available for billing.`),
        { statusCode: 400 },
      );
    }

    const variant =
      item.variants.find((entry) => entry.key === String(input.variantKey || "")) ||
      (item.variants.length === 1 ? item.variants[0] : null);
    if (!variant) {
      throw Object.assign(new Error(`Pick a size for "${item.name}".`), {
        statusCode: 400,
      });
    }

    lines.push({
      productId: item.id,
      name: item.name,
      variant: variant.label,
      category: item.category,
      hsnCode: item.hsnCode,
      qty,
      unitPrice: variant.price,
      gstRate: item.gstRate,
    });
  });

  if (!lines.length) {
    throw Object.assign(new Error("Add at least one item to the bill."), {
      statusCode: 400,
    });
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
  round2,
  dateKeyOf,
  isDateKey,
  isTime,
  istDate,
  shiftDateKey,
  loadCatalog,
  toCatalogItem,
  resolveLines,
  computeBill,
  reserveBillNumbers,
  summarisePaymentMode,
};
