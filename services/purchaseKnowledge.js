const mongoose = require("mongoose");
const { PurchaseItem, ShortName } = require("../models/BillingPurchaseKnowledge");
const StockItem = require("../models/BillingStockItem");
const { ErpMeta } = require("../models/erpModels");
const logger = require("../utils/logger");
const { normaliseName, round2 } = require("./purchaseService");
const { packUnitsOf, round } = require("./stockUnits");

/* What the purchase reader knows beyond the bill itself — the shop (buyer),
 * short forms used on bills, the stock items, and how each supplier prints
 * each item — and keeping stock in step with saved purchase bills. */

const DEFAULT_SHOP_NAME = "Hindumatha's Cake World";

const readShop = async () => {
  const meta = await ErpMeta.findOne({ key: "main" }).select("settings").lean();
  return {
    name: meta?.settings?.shopName || DEFAULT_SHOP_NAME,
    gstin: String(meta?.settings?.gstin || "").toUpperCase(),
  };
};

// Seeded once so the list isn't empty; edit or delete them freely.
const DEFAULT_SHORT_NAMES = [
  ["CDM", "Cadbury Dairy Milk"],
  ["FN", "Fruit & Nut"],
  ["RA", "Roast Almond"],
  ["RTL", "Retail pack"],
  ["CRTN", "Carton"],
  ["PCH", "Pouch"],
];

const listShortNames = async () => {
  if (!(await ShortName.estimatedDocumentCount())) {
    await ShortName.insertMany(
      DEFAULT_SHORT_NAMES.map(([short, full]) => ({ short, full, supplierKey: "" })),
      { ordered: false },
    ).catch(() => {});
  }
  return ShortName.find({}).sort({ short: 1 }).lean();
};

const toStockInfo = (stock) =>
  stock
    ? {
        stockItemId: String(stock._id),
        stockName: stock.name,
        stockQty: stock.stockQty,
        baseUnit: stock.baseUnit || "pcs",
        packUnits: packUnitsOf(stock),
        sellOptions: stock.sellOptions || [],
        // Per base unit.
        mrpPerBase: stock.mrp,
        sellingPrice: stock.sellingPrice,
        lastRate: stock.lastRate,
      }
    : {};

/* A lookup from a bill line to what the shop already knows about it:
 *   1. how this supplier printed it before (alias) → its stock item,
 *   2. how any supplier printed it,
 *   3. a stock item with the same full name ("Cadbury Dairy Milk 44g").
 * Returns null for a product never bought before. */
const loadKnownItems = async () => {
  const [aliases, stockItems] = await Promise.all([
    PurchaseItem.find({}).sort({ uses: -1 }).limit(20000).lean(),
    StockItem.find({}).lean(),
  ]);
  const stockById = new Map(stockItems.map((item) => [String(item._id), item]));
  const stockByName = new Map(stockItems.map((item) => [item.nameKey, item]));
  const bySupplier = new Map();
  const anySupplier = new Map();
  aliases.forEach((alias) => {
    bySupplier.set(`${alias.supplierKey}|${alias.key}`, alias);
    if (!anySupplier.has(alias.key)) anySupplier.set(alias.key, alias);
  });

  return (printedName, supplierName, fullName) => {
    const key = normaliseName(printedName);
    const alias =
      (key && (bySupplier.get(`${normaliseName(supplierName)}|${key}`) || anySupplier.get(key))) || null;
    const stock =
      (alias?.stockItemId && stockById.get(alias.stockItemId)) ||
      stockByName.get(normaliseName(fullName)) ||
      (alias && stockByName.get(normaliseName(alias.name))) ||
      null;
    if (!alias && !stock) return null;
    return {
      name: stock?.name || alias.name,
      categoryId: stock?.categoryId || alias?.categoryId || "",
      hsnCode: stock?.hsnCode || alias?.hsnCode || "",
      gstRate: alias?.gstRate ?? stock?.gstRate ?? null,
      unit: alias?.unit || stock?.unit || "",
      unitFactor: alias?.unitFactor ?? null,
      packSize: stock?.packSize ?? alias?.packSize ?? null,
      ...toStockInfo(stock),
    };
  };
};

// Base units a line adds: (bought + free) × units per billed unit.
const stockQtyOf = (line) =>
  round(((Number(line.qty) || 0) + (Number(line.freeQty) || 0)) * (Number(line.unitFactor) > 0 ? Number(line.unitFactor) : 1));

// A line's billed unit as a pack of the item, when it holds several.
const packFromLine = (line) =>
  Number(line.unitFactor) > 1 && line.unit && line.unit.toLowerCase() !== (line.baseUnit || "pcs")
    ? { name: line.unit.charAt(0).toUpperCase() + line.unit.slice(1), factor: round(line.unitFactor) }
    : null;

const perBase = (value, line) =>
  value > 0 ? round(value / (Number(line.unitFactor) > 0 ? Number(line.unitFactor) : 1), 2) : null;

/* Give every line of a purchase a stock item: the one picked in the editor,
 * else one with the same name, else a new one. Changes data.lines. */
const linkStockItems = async (data) => {
  const wanted = data.lines.map((line) => line.stockItemId).filter((id) => mongoose.isValidObjectId(id));
  const nameKeys = data.lines.map((line) => normaliseName(line.name));
  const existing = await StockItem.find({
    $or: [{ _id: { $in: wanted } }, { nameKey: { $in: nameKeys } }],
  }).lean();
  const byId = new Map(existing.map((item) => [String(item._id), item]));
  const byName = new Map(existing.map((item) => [item.nameKey, item]));
  const created = new Map();

  for (const line of data.lines) {
    const nameKey = normaliseName(line.name);
    let item = (line.stockItemId && byId.get(String(line.stockItemId))) || byName.get(nameKey) || created.get(nameKey);
    if (!item) {
      item = (
        await StockItem.create({
          name: line.name,
          nameKey,
          categoryId: line.categoryId || "",
          hsnCode: line.hsnCode || "",
          gstRate: line.gstRate || 0,
          baseUnit: line.baseUnit || "pcs",
          packUnits: packFromLine(line) ? [packFromLine(line)] : [],
          sellOptions: line.sellOptions || [],
          mrp: perBase(line.mrp, line),
        })
      ).toObject();
      created.set(nameKey, item);
    }
    line.stockItemId = String(item._id);
  }
  return data;
};

/* Add a purchase's lines to stock (sign 1) or take them off again (-1, for
 * an edited or deleted bill). Adding also records the latest rate, MRP,
 * selling options, units and details from the bill. Rates and MRP are kept
 * per base unit. */
const applyStock = async (purchase, sign) => {
  const lines = purchase.lines.filter((line) => mongoose.isValidObjectId(line.stockItemId));
  if (!lines.length) return;
  const items =
    sign > 0
      ? new Map(
          (await StockItem.find({ _id: { $in: lines.map((line) => line.stockItemId) } }).lean()).map((item) => [
            String(item._id),
            item,
          ]),
        )
      : new Map();

  const operations = lines.map((line) => {
    const qty = stockQtyOf(line) * sign;
    const update = { $inc: { stockQty: qty, purchasedQty: qty } };
    if (sign > 0) {
      const item = items.get(String(line.stockItemId));
      const packs = packUnitsOf(item);
      const pack = packFromLine(line);
      const nextPacks =
        pack && !packs.some((entry) => entry.name.toLowerCase() === pack.name.toLowerCase())
          ? [...packs, pack]
          : packs;
      update.$set = {
        lastRate: perBase(line.rate, line),
        lastSupplier: purchase.supplierName,
        lastPurchasedOn: purchase.dateKey,
        packUnits: nextPacks,
        ...(line.baseUnit && (!item || !item.purchasedQty) ? { baseUnit: line.baseUnit } : {}),
        ...(line.categoryId ? { categoryId: line.categoryId } : {}),
        ...(line.hsnCode ? { hsnCode: line.hsnCode } : {}),
        ...(line.gstRate !== undefined ? { gstRate: line.gstRate } : {}),
        ...(line.mrp ? { mrp: perBase(line.mrp, line) } : {}),
        ...(line.sellOptions?.length
          ? { sellOptions: line.sellOptions, sellingPrice: perBase(line.sellOptions[0].price, { unitFactor: line.sellOptions[0].qty }) }
          : {}),
      };
    }
    return { updateOne: { filter: { _id: line.stockItemId }, update } };
  });
  await StockItem.bulkWrite(operations, { ordered: false });
};

/* Remember how this supplier prints each item, so the next bill links the
 * line to the same stock item without asking. */
const learnFromPurchase = async (purchase) => {
  const supplierKey = normaliseName(purchase.supplierName);
  const operations = purchase.lines
    .map((line) => {
      const key = normaliseName(line.printedName || line.name);
      if (!key) return null;
      return {
        updateOne: {
          filter: { key, supplierKey },
          update: {
            $set: {
              supplierName: purchase.supplierName,
              printedName: line.printedName || line.name,
              name: line.name,
              stockItemId: line.stockItemId || "",
              categoryId: line.categoryId || "",
              hsnCode: line.hsnCode || "",
              gstRate: line.gstRate,
              unit: line.unit || "",
              unitFactor: Number(line.unitFactor) > 0 ? Number(line.unitFactor) : 1,
              packSize: line.packSize || null,
              lastRate: round2(line.rate),
            },
            $inc: { uses: 1 },
          },
          upsert: true,
        },
      };
    })
    .filter(Boolean);
  if (!operations.length) return;
  try {
    await PurchaseItem.bulkWrite(operations, { ordered: false });
  } catch (error) {
    logger.warn("Could not save learned purchase items", { error: error.message });
  }
};

module.exports = {
  readShop,
  listShortNames,
  loadKnownItems,
  linkStockItems,
  applyStock,
  learnFromPurchase,
  stockQtyOf,
};
