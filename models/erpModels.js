const mongoose = require("mongoose");

/* ── ERP collections ──────────────────────────────────────────────────────
 * The ERP frontend owns the shape of each record and generates its own
 * business key (`id`, e.g. "sale-1753...") before saving. These schemas are
 * therefore intentionally non-strict: Mongo stores the record faithfully and
 * we only index the fields the server itself queries on.
 *
 * Products and categories are NOT here — they live in the shared `products`
 * collection and the `Category` model below, so the website and the ERP read
 * one catalog. See services/erpStateService.js for the projection.
 * ────────────────────────────────────────────────────────────────────────── */

const recordCollections = {
  ProductBatch: "erp_product_batches",
  Ingredient: "erp_ingredients",
  Recipe: "erp_recipes",
  Production: "erp_productions",
  Bill: "erp_sales",
  HeldBill: "erp_held_bills",
  CakeOrder: "erp_cake_orders",
  Supplier: "erp_suppliers",
  Purchase: "erp_purchases",
  SupplierPayment: "erp_supplier_payments",
  ErpCustomer: "erp_customers",
  CustomerPayment: "erp_customer_payments",
  WriteOff: "erp_write_offs",
  StockAdjustment: "erp_stock_adjustments",
  Expense: "erp_expenses",
};

// Maps the ERP state array field -> model name, used by the state service.
const stateFieldToModel = {
  productBatches: "ProductBatch",
  ingredients: "Ingredient",
  recipes: "Recipe",
  productions: "Production",
  sales: "Bill",
  heldBills: "HeldBill",
  cakeOrders: "CakeOrder",
  suppliers: "Supplier",
  purchases: "Purchase",
  supplierPayments: "SupplierPayment",
  customers: "ErpCustomer",
  customerPayments: "CustomerPayment",
  writeOffs: "WriteOff",
  stockAdjustments: "StockAdjustment",
  expenses: "Expense",
};

const buildRecordModel = (modelName, collectionName) => {
  const schema = new mongoose.Schema(
    {
      id: {
        type: String,
        required: true,
        trim: true,
      },
      updatedAt: {
        type: String,
        default: () => new Date().toISOString(),
      },
    },
    {
      collection: collectionName,
      strict: false,
      minimize: false,
      versionKey: false,
    },
  );

  schema.index({ id: 1 }, { unique: true });

  return mongoose.models[modelName] || mongoose.model(modelName, schema);
};

const models = Object.fromEntries(
  Object.entries(recordCollections).map(([modelName, collectionName]) => [
    modelName,
    buildRecordModel(modelName, collectionName),
  ]),
);

/* ── Category ─────────────────────────────────────────────────────────────
 * Real collection so both panels share one category list. `slug` matches the
 * lowercase `Product.category` string the website already stores, which is
 * how a product resolves to its category without changing the website. */

const categorySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    emoji: { type: String, trim: true, default: "" },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    showOnWebsite: { type: Boolean, default: true },
    createdAt: { type: String, default: () => new Date().toISOString() },
    updatedAt: { type: String, default: () => new Date().toISOString() },
  },
  { collection: "erp_categories", versionKey: false },
);

categorySchema.index({ id: 1 }, { unique: true });
categorySchema.index({ slug: 1 }, { unique: true });

const Category =
  mongoose.models.Category || mongoose.model("Category", categorySchema);

/* ── ErpMeta ──────────────────────────────────────────────────────────────
 * Single document holding shop settings, per-year document counters and the
 * `rev` used for optimistic concurrency between counters/devices. */

const erpMetaSchema = new mongoose.Schema(
  {
    key: { type: String, default: "main", unique: true },
    rev: { type: Number, default: 0 },
    settings: { type: mongoose.Schema.Types.Mixed, default: {} },
    counters: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedAt: { type: String, default: () => new Date().toISOString() },
  },
  { collection: "erp_meta", minimize: false, versionKey: false },
);

const ErpMeta =
  mongoose.models.ErpMeta || mongoose.model("ErpMeta", erpMetaSchema);

module.exports = {
  ...models,
  Category,
  ErpMeta,
  stateFieldToModel,
  recordCollections,
};
