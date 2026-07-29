const Product = require("../models/Product");
const erpModels = require("../models/erpModels");
const logger = require("../utils/logger");

const { Category, ErpMeta, stateFieldToModel } = erpModels;

/* Placeholder used when the ERP creates a shop-only product (a biscuit, a
 * chocolate bar) that has no photo. `Product.image` is required by the
 * website schema, so we never write an empty string. */
const ERP_PLACEHOLDER_IMAGE =
  "https://res.cloudinary.com/dh39jlcy0/image/upload/f_auto,q_auto,w_800/v1/hindumatha/erp-placeholder.png";

const WALK_IN_CUSTOMER_ID = "customer-walkin";

const nowIso = () => new Date().toISOString();
const currentYear = () => new Date().getFullYear();

const DEFAULT_SETTINGS = {
  shopName: "Hindumatha's Cake World",
  address: "",
  phone: "",
  gstin: "",
  fssaiNo: "",
  gstMode: "inclusive",
  invoiceFooter: "Thank you! Visit again.",
  receiptFooter: "Thank you! Visit again.",
  staff: ["Owner"],
  loyaltyEnabled: true,
  loyaltyEarnPerRupees: 100,
  loyaltyPointValue: 1,
};

const DEFAULT_COUNTERS = () => ({
  sale: { year: currentYear(), count: 0 },
  order: { year: currentYear(), count: 0 },
  purchase: { year: currentYear(), count: 0 },
  production: { year: currentYear(), count: 0 },
  writeOff: { year: currentYear(), count: 0 },
});

const SEED_INGREDIENTS = [
  { name: "Maida (Refined Flour)", unit: "kg", minStock: 10, avgCost: 40 },
  { name: "Sugar", unit: "kg", minStock: 10, avgCost: 44 },
  { name: "Butter", unit: "kg", minStock: 2, avgCost: 480 },
  { name: "Eggs", unit: "pcs", minStock: 30, avgCost: 6 },
  { name: "Whipping Cream", unit: "L", minStock: 2, avgCost: 320 },
  { name: "Cocoa Powder", unit: "kg", minStock: 1, avgCost: 600 },
  { name: "Yeast", unit: "kg", minStock: 0.5, avgCost: 350 },
  { name: "Milk", unit: "L", minStock: 5, avgCost: 58 },
];

const CATEGORY_EMOJI = {
  cakes: "🎂",
  cake: "🎂",
  pastries: "🍰",
  pastry: "🍰",
  breads: "🍞",
  bread: "🍞",
  buns: "🍞",
  cookies: "🍪",
  biscuits: "🍪",
  puffs: "🥐",
  snacks: "🥐",
  sweets: "🍮",
  beverages: "🥤",
  drinks: "🥤",
  chocolates: "🍫",
  candles: "🕯️",
  featured: "⭐",
};

const titleCase = (value = "") =>
  String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();

const emojiForCategory = (slug = "") => {
  const normalized = String(slug).toLowerCase();
  const match = Object.keys(CATEGORY_EMOJI).find((key) =>
    normalized.includes(key),
  );
  return match ? CATEGORY_EMOJI[match] : "🧁";
};

/* ── Categories ─────────────────────────────────────────────────────────── */

const ensureCategories = async () => {
  const productCategories = await Product.distinct("category");
  const slugs = productCategories
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);

  const existing = await Category.find({}).lean();
  const existingSlugs = new Set(existing.map((entry) => entry.slug));
  const missing = slugs.filter((slug) => !existingSlugs.has(slug));

  if (missing.length) {
    let sortOrder = existing.length;
    const documents = missing.map((slug) => {
      sortOrder += 1;
      return {
        id: `cat-${slug}`,
        slug,
        name: titleCase(slug),
        emoji: emojiForCategory(slug),
        sortOrder,
        active: true,
        showOnWebsite: true,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
    });

    await Category.insertMany(documents, { ordered: false }).catch((error) => {
      // A concurrent request may have inserted the same slug; harmless.
      logger.warn("ERP category backfill partial", { error: error.message });
    });

    return Category.find({}).lean();
  }

  return existing;
};

/* ── Product projection ─────────────────────────────────────────────────── */

const toErpProduct = (product, categoryIdBySlug) => {
  const visibility = product.visibility || {};
  const slug = String(product.category || "").trim().toLowerCase();

  return {
    id: String(product._id),
    name: product.name,
    categoryId: categoryIdBySlug.get(slug) || "",
    sellPrice: Number(product.price || 0),
    buyPrice: Number(product.costPrice || 0),
    gstRate: Number(product.gstRate ?? 5),
    gstMode: product.gstMode || "inclusive",
    hsnCode: product.hsnCode || "1905",
    unitLabel: product.stockUnit || "pcs",
    shelfLifeDays: Number(product.shelfLifeDays || 0),
    sourceType: product.productType || "inhouse",
    emoji: product.erpEmoji || "",
    imageUrl: product.image || "",
    quickSelect: Boolean(product.erpQuickSelect),
    trackStock: Boolean(product.trackStock),
    reorderLevel: Number(product.reorderLevel || 0),
    isPerishable: Boolean(product.isPerishable),
    sku: product.sku || "",
    barcode: product.barcode || "",
    barcodeType: product.barcodeType || "CODE128",

    // Channel flags, editable from the ERP Products page.
    showOnWebsite: visibility.showOnWebsite !== false,
    allowOnlineOrder: visibility.allowOnlineOrder !== false,
    availableInBilling: visibility.availableInBilling !== false,
    isActive: visibility.isActive !== false,

    // The ERP treats `active` as "sellable at the counter".
    active:
      visibility.availableInBilling !== false && visibility.isActive !== false,

    // Filled in by readState() from live batches; the client recomputes the
    // same value in normalizeState(), so the two can never disagree.
    currentStock: 0,

    createdAt: product.createdAt
      ? new Date(product.createdAt).toISOString()
      : nowIso(),
    updatedAt: nowIso(),
  };
};

const toErpCategory = (category) => ({
  id: category.id,
  slug: category.slug,
  name: category.name,
  emoji: category.emoji || "",
  sortOrder: Number(category.sortOrder || 0),
  active: category.active !== false,
  showOnWebsite: category.showOnWebsite !== false,
});

/* ── Seeding ────────────────────────────────────────────────────────────── */

const ensureSeedRecords = async () => {
  const { Ingredient, ErpCustomer } = erpModels;

  const ingredientCount = await Ingredient.estimatedDocumentCount();
  if (ingredientCount === 0) {
    await Ingredient.insertMany(
      SEED_INGREDIENTS.map((entry, index) => ({
        id: `ing-${index + 1}`,
        name: entry.name,
        unit: entry.unit,
        currentStock: 0,
        minStock: entry.minStock,
        avgCost: entry.avgCost,
        lastPurchasePrice: entry.avgCost,
        active: true,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })),
      { ordered: false },
    ).catch(() => {});
  }

  const walkIn = await ErpCustomer.findOne({ id: WALK_IN_CUSTOMER_ID }).lean();
  if (!walkIn) {
    await ErpCustomer.create({
      id: WALK_IN_CUSTOMER_ID,
      name: "Walk-in Customer",
      phone: "",
      address: "",
      isWalkIn: true,
      outstandingBalance: 0,
      loyaltyPoints: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }).catch(() => {});
  }
};

const ensureMeta = async () => {
  let meta = await ErpMeta.findOne({ key: "main" });

  if (!meta) {
    meta = await ErpMeta.create({
      key: "main",
      rev: 1,
      settings: DEFAULT_SETTINGS,
      counters: DEFAULT_COUNTERS(),
      updatedAt: nowIso(),
    }).catch(async (error) => {
      logger.warn("ERP meta create race", { error: error.message });
      return ErpMeta.findOne({ key: "main" });
    });
  }

  return meta;
};

/* ── Read ───────────────────────────────────────────────────────────────── */

const stripMongoFields = (record) => {
  const { _id, __v, ...rest } = record;
  return rest;
};

const readState = async () => {
  await ensureSeedRecords();

  const [meta, categories] = await Promise.all([
    ensureMeta(),
    ensureCategories(),
  ]);

  const categoryIdBySlug = new Map(
    categories.map((category) => [category.slug, category.id]),
  );

  const products = await Product.find({}).lean();

  const recordEntries = await Promise.all(
    Object.entries(stateFieldToModel).map(async ([field, modelName]) => {
      const records = await erpModels[modelName].find({}).lean();
      return [field, records.map(stripMongoFields)];
    }),
  );

  const records = Object.fromEntries(recordEntries);

  // On-hand stock is the sum of the remaining quantity across live batches.
  const remainingByProduct = new Map();
  (records.productBatches || []).forEach((batch) => {
    const qty = Number(batch.qtyRemaining || 0);
    remainingByProduct.set(
      batch.productId,
      (remainingByProduct.get(batch.productId) || 0) + qty,
    );
  });

  const state = {
    settings: { ...DEFAULT_SETTINGS, ...(meta.settings || {}) },
    counters: { ...DEFAULT_COUNTERS(), ...(meta.counters || {}) },
    categories: categories
      .sort((left, right) => (left.sortOrder || 0) - (right.sortOrder || 0))
      .map(toErpCategory),
    products: products.map((product) => {
      const erpProduct = toErpProduct(product, categoryIdBySlug);
      erpProduct.currentStock = Number(
        (remainingByProduct.get(erpProduct.id) || 0).toFixed(3),
      );
      return erpProduct;
    }),
    ...records,
  };

  return { state, rev: Number(meta.rev || 0) };
};

/* ── Write ──────────────────────────────────────────────────────────────── */

const stableJson = (value) =>
  JSON.stringify(value, Object.keys(value || {}).sort());

const syncRecordCollection = async (modelName, incoming) => {
  const Model = erpModels[modelName];
  const stored = await Model.find({}).lean();
  const storedById = new Map(stored.map((entry) => [entry.id, entry]));

  const operations = [];
  const incomingIds = new Set();

  (Array.isArray(incoming) ? incoming : []).forEach((record) => {
    if (!record || !record.id) {
      return;
    }

    incomingIds.add(record.id);
    const existing = storedById.get(record.id);

    if (existing && stableJson(stripMongoFields(existing)) === stableJson(record)) {
      return; // unchanged
    }

    operations.push({
      replaceOne: {
        filter: { id: record.id },
        replacement: record,
        upsert: true,
      },
    });
  });

  const removedIds = stored
    .map((entry) => entry.id)
    .filter((id) => !incomingIds.has(id));

  if (removedIds.length) {
    operations.push({ deleteMany: { filter: { id: { $in: removedIds } } } });
  }

  if (operations.length) {
    await Model.bulkWrite(operations, { ordered: false });
  }

  return operations.length;
};

const syncCategories = async (incoming) => {
  const stored = await Category.find({}).lean();
  const storedById = new Map(stored.map((entry) => [entry.id, entry]));
  const operations = [];

  (Array.isArray(incoming) ? incoming : []).forEach((category) => {
    if (!category || !category.id) {
      return;
    }

    const existing = storedById.get(category.id);
    const slug =
      String(category.slug || existing?.slug || category.name || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || category.id;

    const payload = {
      id: category.id,
      slug,
      name: category.name,
      emoji: category.emoji || "",
      sortOrder: Number(category.sortOrder || 0),
      active: category.active !== false,
      showOnWebsite: category.showOnWebsite !== false,
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
    };

    operations.push({
      updateOne: {
        filter: { id: category.id },
        update: { $set: payload },
        upsert: true,
      },
    });
  });

  if (operations.length) {
    await Category.bulkWrite(operations, { ordered: false });
  }
};

/* Writes ERP-owned product fields back to the shared catalog. Website-only
 * fields (description, images, flavors, weightOptions, addOns, isFeatured,
 * displayOrder) are never touched here — the website admin owns those. */
const syncProducts = async (incoming, categories) => {
  const slugByCategoryId = new Map(
    (categories || []).map((category) => [category.id, category.slug]),
  );
  const stored = await Product.find({}).lean();
  const storedById = new Map(stored.map((entry) => [String(entry._id), entry]));

  const operations = [];
  let created = 0;

  (Array.isArray(incoming) ? incoming : []).forEach((product) => {
    if (!product || !product.id) {
      return;
    }

    const categorySlug =
      slugByCategoryId.get(product.categoryId) ||
      storedById.get(product.id)?.category ||
      "uncategorised";

    const erpFields = {
      name: product.name,
      price: Number(product.sellPrice || 0),
      category: categorySlug,
      costPrice: Number(product.buyPrice || 0),
      gstRate: Number(product.gstRate ?? 5),
      gstMode: product.gstMode || "inclusive",
      hsnCode: product.hsnCode || "1905",
      stockUnit: product.unitLabel || "pcs",
      shelfLifeDays: Number(product.shelfLifeDays || 0),
      productType: product.sourceType === "resale" ? "resale" : "inhouse",
      erpEmoji: product.emoji || "",
      erpQuickSelect: Boolean(product.quickSelect),
      trackStock: Boolean(product.trackStock),
      reorderLevel: Number(product.reorderLevel || 0),
      isPerishable: Boolean(product.isPerishable),
      "visibility.showOnWebsite": product.showOnWebsite !== false,
      "visibility.allowOnlineOrder": product.allowOnlineOrder !== false,
      "visibility.availableInBilling":
        product.availableInBilling !== false && product.active !== false,
      "visibility.isActive": product.isActive !== false,
    };

    if (product.sku) erpFields.sku = product.sku;
    if (product.barcode) erpFields.barcode = product.barcode;
    if (product.barcodeType) erpFields.barcodeType = product.barcodeType;

    const existing = storedById.get(product.id);

    if (existing) {
      operations.push({
        updateOne: {
          filter: { _id: existing._id },
          update: { $set: erpFields },
        },
      });
      return;
    }

    // Product created from the ERP (a shop-only item). Fill the fields the
    // website schema requires so the document stays valid for both apps.
    created += 1;
    operations.push({
      insertOne: {
        document: {
          ...erpFields,
          description: product.name,
          image: product.imageUrl || ERP_PLACEHOLDER_IMAGE,
          images: product.imageUrl ? [product.imageUrl] : [],
          isAvailable: true,
          createdAt: new Date(),
        },
      },
    });
  });

  const incomingIds = new Set(
    (Array.isArray(incoming) ? incoming : []).map((entry) => entry.id),
  );
  const removedIds = stored
    .map((entry) => String(entry._id))
    .filter((id) => !incomingIds.has(id));

  // Deleting from the ERP archives the product rather than removing it, so a
  // deleted product can never orphan a past bill or a website order line.
  if (removedIds.length) {
    operations.push({
      updateMany: {
        filter: { _id: { $in: removedIds } },
        update: {
          $set: {
            "visibility.isActive": false,
            "visibility.showOnWebsite": false,
            "visibility.allowOnlineOrder": false,
            "visibility.availableInBilling": false,
            isAvailable: false,
          },
        },
      },
    });
  }

  if (operations.length) {
    await Product.bulkWrite(operations, { ordered: false });
  }

  return { created, archived: removedIds.length };
};

const writeState = async (incomingState, expectedRev) => {
  // Compare-and-swap on `rev` claims the write. If another counter committed
  // first the filter misses, and the caller is told to refetch and retry.
  const claimed = await ErpMeta.findOneAndUpdate(
    { key: "main", rev: expectedRev },
    {
      $inc: { rev: 1 },
      $set: {
        settings: incomingState.settings || DEFAULT_SETTINGS,
        counters: incomingState.counters || DEFAULT_COUNTERS(),
        updatedAt: nowIso(),
      },
    },
    { new: true },
  );

  if (!claimed) {
    const current = await ErpMeta.findOne({ key: "main" }).lean();
    const error = new Error("ERP state revision conflict");
    error.code = "ERP_REV_CONFLICT";
    error.currentRev = Number(current?.rev || 0);
    throw error;
  }

  await syncCategories(incomingState.categories);
  const categories = await Category.find({}).lean();
  const productResult = await syncProducts(incomingState.products, categories);

  await Promise.all(
    Object.entries(stateFieldToModel).map(([field, modelName]) =>
      syncRecordCollection(modelName, incomingState[field]),
    ),
  );

  logger.info("ERP state saved", {
    rev: claimed.rev,
    productsCreated: productResult.created,
    productsArchived: productResult.archived,
  });

  return readState();
};

module.exports = {
  readState,
  writeState,
  WALK_IN_CUSTOMER_ID,
  ERP_PLACEHOLDER_IMAGE,
};
