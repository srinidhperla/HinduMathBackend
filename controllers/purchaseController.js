const mongoose = require("mongoose");
const BillingPurchase = require("../models/BillingPurchase");
const logger = require("../utils/logger");
const { isDateKey, loadCategories, dateKeyOf } = require("../services/billingService");
const {
  round2,
  computePurchase,
  fileKind,
  storeBillFile,
  removeBillFile,
  normaliseName,
} = require("../services/purchaseService");
const { aiEnabled, readBill } = require("../services/billReader");
const {
  readShop,
  listShortNames,
  loadKnownItems,
  linkStockItems,
  applyStock,
  learnFromPurchase,
} = require("../services/purchaseKnowledge");
const { PurchaseItem, ShortName } = require("../models/BillingPurchaseKnowledge");
const StockItem = require("../models/BillingStockItem");
const StockAdjustment = require("../models/BillingStockAdjustment");
const BillingBill = require("../models/BillingBill");
const { BASE_UNITS, packUnitsOf, parseSellOptions } = require("../services/stockUnits");

/* Purchases — supplier bills entered by hand or read from an uploaded file,
 * each item placed in a billing category. Mounted under /api/billing. */

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

const fail = (res, error, fallback) => {
  const status = error.statusCode || 500;
  if (status >= 500) logger.error(fallback, { error: error.message });
  return res
    .status(status)
    .json({ message: status >= 500 && !error.statusCode ? fallback : error.message });
};

const MAX_LINES = 300;

const text = (value, max = 120) => String(value ?? "").trim().slice(0, max);

const number = (value, label, { min = 0 } = {}) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw badRequest(`${label} must be a number${min === 0 ? " of 0 or more" : ""}.`);
  }
  return parsed;
};

/* Validate and tidy a purchase sent from the editor. */
const parsePurchaseBody = (body, categories) => {
  const supplierName = text(body.supplierName);
  if (!supplierName) throw badRequest("Enter the supplier's name.");
  if (!isDateKey(body.dateKey)) throw badRequest("Enter the bill date.");

  const inputLines = Array.isArray(body.lines) ? body.lines : [];
  if (!inputLines.length) throw badRequest("Add at least one item.");
  if (inputLines.length > MAX_LINES) throw badRequest(`A bill can have at most ${MAX_LINES} items.`);

  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const lines = inputLines.map((line, index) => {
    const label = `Item ${index + 1}`;
    const name = text(line.name);
    if (!name) throw badRequest(`${label} needs a name.`);
    const qty = number(line.qty, `${label} quantity`);
    if (qty <= 0) throw badRequest(`${label} quantity must be above 0.`);
    const gstRate = number(line.gstRate || 0, `${label} GST %`);
    if (gstRate > 100) throw badRequest(`${label} GST % is too high.`);
    const category = line.categoryId ? categoriesById.get(String(line.categoryId)) : null;
    if (line.categoryId && !category) throw badRequest(`${label}'s category no longer exists.`);
    const optional = (value, label) =>
      value === null || value === undefined || value === "" ? null : number(value, label);
    return {
      name,
      printedName: text(line.printedName, 160),
      freeQty: number(line.freeQty || 0, `${label} free quantity`),
      packSize: optional(line.packSize, `${label} pack size`),
      mrp: optional(line.mrp, `${label} MRP`),
      sellingPrice: optional(line.sellingPrice, `${label} selling price`),
      stockItemId: mongoose.isValidObjectId(line.stockItemId) ? String(line.stockItemId) : "",
      ...(() => {
        const baseUnit = BASE_UNITS.includes(line.baseUnit) ? line.baseUnit : "pcs";
        const unitFactor =
          line.unitFactor === undefined || line.unitFactor === null || line.unitFactor === ""
            ? 1
            : number(line.unitFactor, `${label} units per ${line.unit || "unit"}`);
        if (!(unitFactor > 0)) throw badRequest(`${label}: how many ${baseUnit} are in one ${line.unit || "unit"}?`);
        return {
          baseUnit,
          unitFactor,
          sellOptions: parseSellOptions(line.sellOptions, baseUnit, []),
        };
      })(),
      hsnCode: text(line.hsnCode, 12),
      categoryId: category?.id || "",
      category: category?.name || "",
      qty,
      unit: text(line.unit, 20),
      // Kept to 4 decimals: supplier rates like ₹72.857 must stay exact.
      rate: Math.round(number(line.rate, `${label} rate`) * 10000) / 10000,
      discount: round2(number(line.discount || 0, `${label} discount`)),
      gstRate,
    };
  });

  const otherCharges = round2(Number(body.otherCharges) || 0);
  const lessDiscount = round2(Number(body.lessDiscount) || 0);
  if (lessDiscount < 0) throw badRequest("The deduction can't be negative.");
  const roundOff = round2(Number(body.roundOff) || 0);
  const taxType = body.taxType === "inter" ? "inter" : "intra";
  const totals = computePurchase({ lines, taxType, otherCharges, lessDiscount, roundOff });
  if (totals.lines.some((line) => line.taxable < 0)) {
    throw badRequest("A line's discount is more than its value.");
  }

  const billTotal =
    body.billTotal === null || body.billTotal === undefined || body.billTotal === ""
      ? null
      : round2(number(body.billTotal, "Bill total"));

  const toAttachment = (entry) => ({
    url: text(entry.url, 500),
    publicId: text(entry.publicId, 300),
    resourceType: text(entry.resourceType, 10),
    mimeType: text(entry.mimeType, 120),
    fileName: text(entry.fileName, 120),
  });
  const files = Array.isArray(body.attachments)
    ? body.attachments
    : body.attachment && typeof body.attachment === "object" && body.attachment.url
      ? [body.attachment]
      : null;
  const attachments = files
    ? files.filter((entry) => entry && typeof entry === "object" && entry.url).slice(0, 10).map(toAttachment)
    : undefined;

  return {
    supplierName,
    supplierGstin: text(body.supplierGstin, 20).toUpperCase(),
    supplierPhone: text(body.supplierPhone, 20),
    invoiceNo: text(body.invoiceNo, 40),
    dateKey: body.dateKey,
    taxType,
    ...totals,
    billTotal,
    notes: text(body.notes, 500),
    source: body.source === "ai" ? "ai" : "manual",
    ...(attachments !== undefined
      ? { attachments, attachment: attachments[0] || { url: "" } }
      : {}),
  };
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toListEntry = (purchase) => ({
  id: String(purchase._id),
  supplierName: purchase.supplierName,
  invoiceNo: purchase.invoiceNo,
  dateKey: purchase.dateKey,
  itemCount: purchase.lines.length,
  categories: [...new Set(purchase.lines.map((line) => line.category || "Uncategorised"))],
  taxable: purchase.taxable,
  gst: purchase.gst,
  total: purchase.total,
  billTotal: purchase.billTotal,
  source: purchase.source,
  hasFile: Boolean(purchase.attachments?.length || purchase.attachment?.url),
});

const toPurchase = (purchase) => ({
  ...purchase,
  attachments: purchase.attachments?.length
    ? purchase.attachments
    : purchase.attachment?.url
      ? [purchase.attachment]
      : [],
  id: String(purchase._id),
  _id: undefined,
  __v: undefined,
});

/* GET /purchases?from&to&q&categoryId — the list plus category, supplier and
 * GST-rate totals for the period. */
const listPurchases = async (req, res) => {
  try {
    const { from, to, q, categoryId } = req.query;
    if (!isDateKey(from) || !isDateKey(to) || from > to) {
      throw badRequest("Choose a valid date range.");
    }
    const filter = { dateKey: { $gte: from, $lte: to } };
    const term = text(q, 60);
    if (term) {
      const pattern = new RegExp(escapeRegex(term), "i");
      filter.$or = [{ supplierName: pattern }, { invoiceNo: pattern }, { "lines.name": pattern }];
    }
    if (categoryId) {
      filter["lines.categoryId"] = categoryId === "none" ? "" : String(categoryId);
    }

    const [purchases, supplierNames] = await Promise.all([
      BillingPurchase.find(filter).sort({ dateKey: -1, createdAt: -1 }).limit(2000).lean(),
      BillingPurchase.aggregate([
        { $sort: { dateKey: -1 } },
        {
          $group: {
            _id: "$supplierName",
            gstin: { $first: "$supplierGstin" },
            phone: { $first: "$supplierPhone" },
            taxType: { $first: "$taxType" },
          },
        },
        { $sort: { _id: 1 } },
        { $limit: 500 },
      ]),
    ]);

    const byCategory = new Map();
    const bySupplier = new Map();
    const byRate = new Map();
    let extras = 0;
    purchases.forEach((purchase) => {
      extras += (purchase.otherCharges || 0) + (purchase.roundOff || 0);
      const supplier = bySupplier.get(purchase.supplierName) || {
        name: purchase.supplierName,
        bills: 0,
        total: 0,
      };
      supplier.bills += 1;
      supplier.total += purchase.total;
      bySupplier.set(purchase.supplierName, supplier);

      purchase.lines.forEach((line) => {
        const key = line.categoryId || "";
        const entry = byCategory.get(key) || {
          categoryId: key,
          name: line.category || "Uncategorised",
          taxable: 0,
          gst: 0,
          amount: 0,
          lines: 0,
        };
        entry.taxable += line.taxable;
        entry.gst += line.gst;
        entry.amount += line.amount;
        entry.lines += 1;
        byCategory.set(key, entry);

        const rate = byRate.get(line.gstRate) || { gstRate: line.gstRate, taxable: 0, gst: 0 };
        rate.taxable += line.taxable;
        rate.gst += line.gst;
        byRate.set(line.gstRate, rate);
      });
    });

    const tidy = (entry) =>
      Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key,
          typeof value === "number" && !["lines", "bills", "gstRate"].includes(key) ? round2(value) : value,
        ]),
      );

    return res.json({
      from,
      to,
      aiEnabled: aiEnabled(),
      purchases: purchases.map(toListEntry),
      summary: {
        bills: purchases.length,
        taxable: round2(purchases.reduce((sum, purchase) => sum + purchase.taxable, 0)),
        gst: round2(purchases.reduce((sum, purchase) => sum + purchase.gst, 0)),
        total: round2(purchases.reduce((sum, purchase) => sum + purchase.total, 0)),
        extras: round2(extras),
        byCategory: [...byCategory.values()].map(tidy).sort((a, b) => b.amount - a.amount),
        bySupplier: [...bySupplier.values()].map(tidy).sort((a, b) => b.total - a.total),
        byRate: [...byRate.values()].map(tidy).sort((a, b) => a.gstRate - b.gstRate),
      },
      suppliers: supplierNames.map((entry) => ({
        name: entry._id,
        gstin: entry.gstin || "",
        phone: entry.phone || "",
        taxType: entry.taxType || "intra",
      })),
    });
  } catch (error) {
    return fail(res, error, "Could not load purchases.");
  }
};

const findPurchase = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw Object.assign(new Error("Purchase not found."), { statusCode: 404 });
  const purchase = await BillingPurchase.findById(id).lean();
  if (!purchase) throw Object.assign(new Error("Purchase not found."), { statusCode: 404 });
  return purchase;
};

const getPurchase = async (req, res) => {
  try {
    return res.json({ purchase: toPurchase(await findPurchase(req.params.id)) });
  } catch (error) {
    return fail(res, error, "Could not load the purchase.");
  }
};

/* Same supplier and bill number already entered — usually a double entry. */
const duplicateOf = async (data, exceptId) => {
  if (!data.invoiceNo) return null;
  return BillingPurchase.findOne({
    supplierName: new RegExp(`^${escapeRegex(data.supplierName)}$`, "i"),
    invoiceNo: new RegExp(`^${escapeRegex(data.invoiceNo)}$`, "i"),
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  }).lean();
};

const duplicateError = (existing) =>
  Object.assign(
    new Error(
      `Bill ${existing.invoiceNo} from ${existing.supplierName} is already entered (dated ${existing.dateKey}).`,
    ),
    { statusCode: 409, duplicate: true },
  );

const createPurchase = async (req, res) => {
  try {
    const data = parsePurchaseBody(req.body || {}, await loadCategories());
    if (!req.body.allowDuplicate) {
      const existing = await duplicateOf(data);
      if (existing) throw duplicateError(existing);
    }
    // Each line adds to a stock item: an existing one, or a new one.
    await linkStockItems(data);
    const purchase = await BillingPurchase.create({
      ...data,
      createdById: req.user.id,
      createdByName: req.user.name || "",
    });
    await applyStock(data, 1);
    await learnFromPurchase(data);
    return res.status(201).json({ purchase: toPurchase(purchase.toObject()) });
  } catch (error) {
    if (error.duplicate) return res.status(409).json({ message: error.message, duplicate: true });
    return fail(res, error, "Could not save the purchase.");
  }
};

const updatePurchase = async (req, res) => {
  try {
    const current = await findPurchase(req.params.id);
    const data = parsePurchaseBody(req.body || {}, await loadCategories());
    if (!req.body.allowDuplicate) {
      const existing = await duplicateOf(data, current._id);
      if (existing) throw duplicateError(existing);
    }
    await linkStockItems(data);
    const purchase = await BillingPurchase.findByIdAndUpdate(current._id, data, {
      new: true,
      runValidators: true,
    }).lean();
    // Take the old lines off stock and put the edited ones on.
    await applyStock(current, -1);
    await applyStock(data, 1);
    // Files dropped from the bill in the editor are removed from storage.
    if (data.attachments) {
      const kept = new Set(data.attachments.map((entry) => entry.publicId));
      const before = current.attachments?.length
        ? current.attachments
        : current.attachment?.url
          ? [current.attachment]
          : [];
      await Promise.all(
        before.filter((entry) => entry.publicId && !kept.has(entry.publicId)).map(removeBillFile),
      );
    }
    await learnFromPurchase(data);
    return res.json({ purchase: toPurchase(purchase) });
  } catch (error) {
    if (error.duplicate) return res.status(409).json({ message: error.message, duplicate: true });
    return fail(res, error, "Could not update the purchase.");
  }
};

const deletePurchase = async (req, res) => {
  try {
    const purchase = await findPurchase(req.params.id);
    await BillingPurchase.deleteOne({ _id: purchase._id });
    await applyStock(purchase, -1);
    const files = purchase.attachments?.length ? purchase.attachments : [purchase.attachment];
    await Promise.all(files.filter(Boolean).map(removeBillFile));
    logger.info("Purchase deleted", {
      id: String(purchase._id),
      supplier: purchase.supplierName,
      invoiceNo: purchase.invoiceNo,
      by: req.user.name || req.user.id,
    });
    return res.json({ ok: true });
  } catch (error) {
    return fail(res, error, "Could not delete the purchase.");
  }
};

/* POST /purchases/upload — multipart `files` (1–6 photos, PDFs or sheets
 * of ONE bill, pages in order), optional `text` (sheet rows read in the
 * browser) and `read` ("1" to read the bill with AI). Stores the files and
 * returns a draft to check in the editor. */
const uploadPurchaseBill = async (req, res) => {
  try {
    const files = req.files || [];
    const sheetText = text(req.body?.text, 60000);
    if (!files.length && !sheetText) throw badRequest("Choose the bill file.");
    if (files.some((file) => !fileKind(file))) {
      throw badRequest("Upload photos, PDFs, Excel or CSV files only.");
    }

    const wantsRead = String(req.body?.read || "") === "1";
    // The files are kept even when reading fails, so the bill can be typed
    // in by hand next to them.
    const [attachments, reading] = await Promise.all([
      Promise.all(files.map(storeBillFile)),
      wantsRead
        ? (async () => {
            const [categories, shop, shortNames, knownItem] = await Promise.all([
              loadCategories(),
              readShop(),
              listShortNames(),
              loadKnownItems(),
            ]);
            return readBill({
              files: files.filter((file) => fileKind(file) !== "sheet"),
              sheetText,
              categories,
              shop,
              shortNames,
              knownItem,
            });
          })().catch((error) => ({ error }))
        : Promise.resolve(null),
    ]);

    if (reading?.error) {
      logger.warn("Purchase bill read failed", { error: reading.error.message });
      return res.json({
        attachments,
        draft: null,
        readError: reading.error.message || "The bill could not be read.",
      });
    }
    return res.json({
      attachments,
      draft: reading?.draft || null,
      review: reading?.review || null,
      meta: reading
        ? {
            model: reading.meta.model,
            seconds: reading.meta.seconds,
            attempts: reading.meta.attempts,
            pages: reading.meta.pages,
          }
        : null,
      readError: "",
    });
  } catch (error) {
    return fail(res, error, "Could not upload the bill.");
  }
};

/* ── Short names and learned items ───────────────────────────────────── */

const toShortName = (entry) => ({
  id: String(entry._id),
  short: entry.short,
  full: entry.full,
  supplierName: entry.supplierName || "",
});

const getShortNames = async (req, res) => {
  try {
    return res.json({ shortNames: (await listShortNames()).map(toShortName) });
  } catch (error) {
    return fail(res, error, "Could not load short names.");
  }
};

const saveShortName = async (req, res) => {
  try {
    const short = text(req.body?.short, 40);
    const full = text(req.body?.full, 120);
    const supplierName = text(req.body?.supplierName, 120);
    if (!short || !full) throw badRequest("Enter the short form and what it means.");
    const entry = await ShortName.findOneAndUpdate(
      { short, supplierKey: normaliseName(supplierName) },
      { $set: { full, supplierName } },
      { new: true, upsert: true },
    ).lean();
    return res.json({ shortName: toShortName(entry) });
  } catch (error) {
    return fail(res, error, "Could not save the short name.");
  }
};

const deleteShortName = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw badRequest("Unknown short name.");
    await ShortName.deleteOne({ _id: req.params.id });
    return res.json({ ok: true });
  } catch (error) {
    return fail(res, error, "Could not delete the short name.");
  }
};

const listLearnedItems = async (req, res) => {
  try {
    const term = text(req.query.q, 60);
    const filter = term
      ? {
          $or: ["name", "printedName", "supplierName"].map((field) => ({
            [field]: new RegExp(escapeRegex(term), "i"),
          })),
        }
      : {};
    const items = await PurchaseItem.find(filter).sort({ uses: -1, updatedAt: -1 }).limit(500).lean();
    return res.json({
      items: items.map((item) => ({
        id: String(item._id),
        printedName: item.printedName,
        name: item.name,
        supplierName: item.supplierName,
        categoryId: item.categoryId,
        hsnCode: item.hsnCode,
        gstRate: item.gstRate,
        unit: item.unit,
        packSize: item.packSize,
        lastRate: item.lastRate,
        uses: item.uses,
      })),
    });
  } catch (error) {
    return fail(res, error, "Could not load learned items.");
  }
};

const updateLearnedItem = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw badRequest("Unknown item.");
    const update = {};
    if (req.body.name !== undefined) {
      update.name = text(req.body.name);
      if (!update.name) throw badRequest("Enter the item's name.");
    }
    if (req.body.categoryId !== undefined) update.categoryId = text(req.body.categoryId, 40);
    if (req.body.hsnCode !== undefined) update.hsnCode = text(req.body.hsnCode, 12).replace(/\D/g, "");
    if (req.body.packSize !== undefined) {
      update.packSize =
        req.body.packSize === null || req.body.packSize === ""
          ? null
          : number(req.body.packSize, "Pack size");
    }
    const item = await PurchaseItem.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean();
    if (!item) throw Object.assign(new Error("Item not found."), { statusCode: 404 });
    return res.json({ ok: true });
  } catch (error) {
    return fail(res, error, "Could not update the item.");
  }
};

const deleteLearnedItem = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw badRequest("Unknown item.");
    await PurchaseItem.deleteOne({ _id: req.params.id });
    return res.json({ ok: true });
  } catch (error) {
    return fail(res, error, "Could not delete the item.");
  }
};

/* ── Stock ────────────────────────────────────────────────────────────── */

// Where "Low" starts: the level set on the item, else one box, else a
// fifth of what has been bought.
const lowLevelOf = (item) => {
  if (item.reorderLevel !== null && item.reorderLevel !== undefined) return Number(item.reorderLevel);
  const packs = packUnitsOf(item);
  if (packs.length) return Math.min(...packs.map((pack) => pack.factor));
  return round2((Number(item.purchasedQty) || 0) / 5);
};

// Price of one stock unit when sold: the cheapest-per-unit selling option,
// else the MRP.
const sellPerBaseOf = (item) => {
  const perUnit = (item.sellOptions || [])
    .filter((option) => option.qty > 0 && option.price > 0)
    .map((option) => option.price / option.qty);
  if (perUnit.length) return Math.max(...perUnit);
  return Number(item.mrp) > 0 ? Number(item.mrp) : null;
};

const toStockItem = (item) => {
  const stockQty = round2(item.stockQty);
  const lowAt = lowLevelOf(item);
  const sellPerBase = sellPerBaseOf(item);
  const lastRate = item.lastRate ?? null;
  return {
    id: String(item._id),
    name: item.name,
    categoryId: item.categoryId,
    hsnCode: item.hsnCode,
    gstRate: item.gstRate,
    baseUnit: item.baseUnit || "pcs",
    packUnits: packUnitsOf(item),
    sellOptions: item.sellOptions || [],
    unit: item.unit,
    packSize: item.packSize,
    mrp: item.mrp,
    sellingPrice: item.sellingPrice,
    lastRate,
    lastSupplier: item.lastSupplier,
    lastPurchasedOn: item.lastPurchasedOn,
    stockQty,
    purchasedQty: round2(item.purchasedQty),
    soldQty: round2(item.soldQty),
    adjustedQty: round2(item.adjustedQty),
    reorderLevel: item.reorderLevel ?? null,
    lowAt,
    status: stockQty < 0 ? "negative" : stockQty === 0 ? "out" : stockQty <= lowAt ? "low" : "ok",
    sellPerBase: sellPerBase !== null ? round2(sellPerBase) : null,
    // Value of what is on the shelf: at the last purchase rate (before GST)
    // and at the shop's selling price.
    costValue: lastRate !== null ? round2(Math.max(0, stockQty) * lastRate) : 0,
    sellValue: sellPerBase !== null ? round2(Math.max(0, stockQty) * sellPerBase) : 0,
    // Margin of the selling price over the purchase rate with GST.
    marginPercent:
      sellPerBase && lastRate
        ? round2(((sellPerBase - lastRate * (1 + (item.gstRate || 0) / 100)) / sellPerBase) * 100)
        : null,
  };
};

/* GET /purchases/stock?q — every stock item, for the Stock page and for
 * linking bill lines to an existing item in the purchase editor. */
const listStock = async (req, res) => {
  try {
    const term = text(req.query.q, 60);
    const filter = term ? { name: new RegExp(escapeRegex(term), "i") } : {};
    const items = await StockItem.find(filter).sort({ name: 1 }).limit(5000).lean();
    return res.json({ items: items.map(toStockItem) });
  } catch (error) {
    return fail(res, error, "Could not load stock.");
  }
};

/* PATCH /purchases/stock/:id — name, category, MRP, selling options, low
 * stock level, units. Stock quantity changes go through /adjust. */
const updateStock = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw badRequest("Unknown stock item.");
    const body = req.body || {};
    const update = {};
    if (body.name !== undefined) {
      const name = text(body.name);
      if (!name) throw badRequest("Enter the item's name.");
      const clash = await StockItem.findOne({ nameKey: normaliseName(name), _id: { $ne: req.params.id } }).lean();
      if (clash) throw badRequest(`"${clash.name}" already exists in stock.`);
      update.name = name;
      update.nameKey = normaliseName(name);
    }
    if (body.categoryId !== undefined) update.categoryId = text(body.categoryId, 40);
    const optionalNumber = (key, label) => {
      if (body[key] === undefined) return;
      update[key] = body[key] === null || body[key] === "" ? null : number(body[key], label);
    };
    optionalNumber("mrp", "MRP");
    optionalNumber("sellingPrice", "Selling price");
    optionalNumber("packSize", "Pack size");
    optionalNumber("reorderLevel", "Low stock level");
    const current = await StockItem.findById(req.params.id).lean();
    if (!current) throw Object.assign(new Error("Stock item not found."), { statusCode: 404 });
    if (body.baseUnit !== undefined) {
      if (!BASE_UNITS.includes(body.baseUnit)) throw badRequest("Stock unit must be pcs, kg or litre.");
      if (body.baseUnit !== (current.baseUnit || "pcs") && current.purchasedQty) {
        throw badRequest("This item already has purchases in its stock unit; the unit can't change now.");
      }
      update.baseUnit = body.baseUnit;
    }
    if (body.packUnits !== undefined) {
      update.packUnits = (Array.isArray(body.packUnits) ? body.packUnits : [])
        .map((entry) => ({ name: "Box", factor: Number(entry?.factor) }))
        .filter((entry) => entry.factor > 0)
        .slice(0, 10);
    }
    if (body.sellOptions !== undefined) {
      const baseUnit = update.baseUnit || current.baseUnit || "pcs";
      update.sellOptions = parseSellOptions(body.sellOptions, baseUnit, update.packUnits || packUnitsOf(current));
    }
    const item = await StockItem.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean();
    return res.json({ item: toStockItem(item) });
  } catch (error) {
    return fail(res, error, "Could not update the stock item.");
  }
};

/* POST /purchases/stock/:id/adjust — a stock count: set the stock to what
 * was counted on the shelf, with a reason, and keep a record of it. */
const adjustStock = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw badRequest("Unknown stock item.");
    const counted = Number(req.body?.countedQty);
    if (!Number.isFinite(counted) || counted < 0) throw badRequest("Enter the counted quantity (0 or more).");
    const reason = text(req.body?.reason, 200);
    if (!reason) throw badRequest("Give a reason, e.g. counted, damaged or expired.");
    const item = await StockItem.findById(req.params.id).lean();
    if (!item) throw Object.assign(new Error("Stock item not found."), { statusCode: 404 });

    const countedQty = round2(counted);
    const diff = round2(countedQty - (item.stockQty || 0));
    // $inc by the difference, so a sale saved at the same moment isn't lost.
    const updated = await StockItem.findByIdAndUpdate(
      item._id,
      { $inc: { stockQty: diff, adjustedQty: diff } },
      { new: true },
    ).lean();
    await StockAdjustment.create({
      stockItemId: String(item._id),
      itemName: item.name,
      expectedQty: round2(item.stockQty),
      countedQty,
      diff,
      reason,
      dateKey: isDateKey(req.body?.dateKey) ? req.body.dateKey : dateKeyOf(),
      byId: req.user.id,
      byName: req.user.name || "",
    });
    logger.info("Stock counted", { item: item.name, diff, by: req.user.name || req.user.id });
    return res.json({ item: toStockItem(updated) });
  } catch (error) {
    return fail(res, error, "Could not adjust the stock.");
  }
};

/* GET /purchases/stock/:id/history — every movement of one item, newest
 * first: purchase bills (+), sale bills (−), stock counts (±). */
const stockHistory = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw badRequest("Unknown stock item.");
    const id = String(req.params.id);
    const [purchases, bills, counts] = await Promise.all([
      BillingPurchase.find({ "lines.stockItemId": id })
        .select("supplierName invoiceNo dateKey lines createdAt")
        .sort({ dateKey: -1 })
        .limit(200)
        .lean(),
      BillingBill.find({ "items.stockItemId": id, status: "active" })
        .select("billNo dateKey billDate source items")
        .sort({ billDate: -1 })
        .limit(300)
        .lean(),
      StockAdjustment.find({ stockItemId: id }).sort({ createdAt: -1 }).limit(100).lean(),
    ]);

    const moves = [];
    purchases.forEach((purchase) => {
      purchase.lines
        .filter((line) => line.stockItemId === id)
        .forEach((line) => {
          const factor = Number(line.unitFactor) > 0 ? Number(line.unitFactor) : 1;
          moves.push({
            type: "purchase",
            dateKey: purchase.dateKey,
            at: purchase.createdAt,
            qty: round2(((line.qty || 0) + (line.freeQty || 0)) * factor),
            detail: `${purchase.supplierName}${purchase.invoiceNo ? ` · ${purchase.invoiceNo}` : ""}`,
            // Older bills saved pack names (Display, Hanger …); all are Boxes.
            note: `${line.qty}${line.freeQty ? ` + ${line.freeQty} free` : ""} ${
              factor > 1 ? `Box (${factor})` : line.unit || ""
            } at ₹${round2(line.rate)}`.trim(),
            purchaseId: String(purchase._id),
          });
        });
    });
    bills.forEach((bill) => {
      const qty = bill.items
        .filter((line) => line.stockItemId === id)
        .reduce((sum, line) => sum + (Number(line.stockQty) || 0), 0);
      moves.push({
        type: "sale",
        dateKey: bill.dateKey,
        at: bill.billDate,
        qty: round2(-qty),
        detail: `Bill ${bill.billNo}`,
        note: bill.source === "auto" ? "Auto billing" : "Counter",
      });
    });
    counts.forEach((count) => {
      moves.push({
        type: "count",
        dateKey: count.dateKey,
        at: count.createdAt,
        qty: count.diff,
        detail: `Counted ${count.countedQty} (expected ${count.expectedQty})`,
        note: `${count.reason}${count.byName ? ` · ${count.byName}` : ""}`,
      });
    });
    moves.sort((left, right) => new Date(right.at) - new Date(left.at));
    return res.json({ moves });
  } catch (error) {
    return fail(res, error, "Could not load the item's history.");
  }
};

module.exports = {
  listStock,
  updateStock,
  adjustStock,
  stockHistory,
  listPurchases,
  getPurchase,
  createPurchase,
  updatePurchase,
  deletePurchase,
  uploadPurchaseBill,
  getShortNames,
  saveShortName,
  deleteShortName,
  listLearnedItems,
  updateLearnedItem,
  deleteLearnedItem,
};
