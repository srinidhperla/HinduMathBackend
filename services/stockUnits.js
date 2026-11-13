/* ── Units for stock items ───────────────────────────────────────────────
 * Stock is counted in one base unit per item — pcs, kg or litre. A bill
 * line is in some unit (PCS, BOX, DISPLAY, KG, 500 GM …); its factor says
 * how many base units one of it holds, so stock moves by
 * (qty + free) × factor.
 * ────────────────────────────────────────────────────────────────────────── */

const BASE_UNITS = ["pcs", "kg", "litre"];

const clean = (unit) => String(unit || "").toLowerCase().replace(/[^a-z]/g, "");

// Units that are a weight or volume, in kg / litre.
const MEASURES = {
  kg: ["kg", 1], kgs: ["kg", 1], kilo: ["kg", 1], kilogram: ["kg", 1],
  g: ["kg", 0.001], gm: ["kg", 0.001], gms: ["kg", 0.001], gram: ["kg", 0.001], grams: ["kg", 0.001], grm: ["kg", 0.001],
  l: ["litre", 1], lt: ["litre", 1], ltr: ["litre", 1], ltrs: ["litre", 1], litre: ["litre", 1], liter: ["litre", 1],
  ml: ["litre", 0.001],
};

// Single pieces.
const PIECES = new Set(["pcs", "pc", "piece", "pieces", "nos", "no", "ea", "each", "unit", "units", "u", "btl", "bottle", "pkt", "packet", "pak", "pck", "pouch", "pch", "bar", "tin", "can", ""]);

// Containers of several pieces.
const PACKS = new Set(["box", "bx", "display", "dispaly", "disp", "case", "cs", "hanger", "jar", "crtn", "carton", "ctn", "outer", "bundle", "tray", "strip", "dozen", "doz", "pack", "bag", "shrink", "shrinkpack"]);

// Every multi-piece pack (display, hanger, carton, bag …) is called a Box;
// its size says how many it holds. Only pcs, Box, g, kg, ml, litre are used.
const titleUnit = () => "Box";

/* Pack units of a stock item, as Boxes of different sizes, including ones
 * saved before units existed or under other names (Display, Hanger …). */
const packUnitsOf = (stock) => {
  const packs = stock?.packUnits?.length
    ? stock.packUnits
    : stock?.packSize > 1
      ? [{ name: "Box", factor: stock.packSize }]
      : [];
  const seen = new Set();
  return packs
    .filter((pack) => Number(pack.factor) > 0 && !seen.has(Number(pack.factor)) && seen.add(Number(pack.factor)))
    .map((pack) => ({ name: "Box", factor: Number(pack.factor) }));
};

/* What a bill line's unit means for stock: { baseUnit, unitFactor, unit }.
 * Uses the stock item's own units when the line is linked to one. */
const suggestUnit = ({ unit, packSize }, stock) => {
  const key = clean(unit);
  const pack = Number(packSize) > 1 ? Number(packSize) : null;

  const isPack = PACKS.has(key) || key === "dozen" || key === "doz";
  const packCount = key === "dozen" || key === "doz" ? 12 : pack;

  // "250 GMS", "1KG", "500ml": a pack of a measured amount — a Box holding
  // that much (0.25 kg).
  const sized = String(unit || "").trim().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/i);
  if (sized && MEASURES[clean(sized[2])]) {
    const [base, factor] = MEASURES[clean(sized[2])];
    if (!stock || (stock.baseUnit || "pcs") === base) {
      const amount = round(Number(sized[1]) * factor);
      return amount === 1
        ? { baseUnit: base, unitFactor: 1, unit: base }
        : { baseUnit: base, unitFactor: amount, unit: "Box" };
    }
  }

  if (stock) {
    const base = stock.baseUnit || "pcs";
    const packs = packUnitsOf(stock);
    const measure = MEASURES[key];
    if (measure && measure[0] === base) return { baseUnit: base, unitFactor: measure[1], unit: measure[1] === 1 ? base : key === "ml" ? "ml" : "g" };
    if (PIECES.has(key) && base === "pcs") return { baseUnit: base, unitFactor: 1, unit: "pcs" };
    if (isPack || key === "box") {
      // The size printed on this bill, else the item's only box size.
      const size = packCount || (packs.length === 1 ? packs[0].factor : null);
      return { baseUnit: base, unitFactor: size, unit: "Box" };
    }
  }

  const measure = MEASURES[key];
  if (measure) return { baseUnit: measure[0], unitFactor: measure[1], unit: measure[1] === 1 ? measure[0] : key === "ml" ? "ml" : "g" };
  // A box, display, hanger, bag … whose size isn't printed is left without a
  // size, so the editor asks how many it holds.
  if (isPack || key === "box") return { baseUnit: "pcs", unitFactor: packCount || null, unit: "Box" };
  // Pieces, and any other word, count one each.
  return { baseUnit: "pcs", unitFactor: 1, unit: "pcs" };
};

const round = (value, places = 4) => Math.round((Number(value) || 0) * 10 ** places) / 10 ** places;

/* "250 g", "1 kg", "500 ml", "1 pc", "Box (24)" — a name for a quantity. */
const quantityLabel = (qty, baseUnit, packUnits = []) => {
  const amount = Number(qty) || 0;
  if (baseUnit === "kg") return amount < 1 ? `${round(amount * 1000, 0)} g` : `${round(amount, 3)} kg`;
  if (baseUnit === "litre") return amount < 1 ? `${round(amount * 1000, 0)} ml` : `${round(amount, 3)} L`;
  const pack = packUnits.find((entry) => entry.factor === amount && amount > 1);
  if (pack) return `${pack.name} (${amount})`;
  return amount === 1 ? "1 pc" : `${round(amount, 3)} pcs`;
};

/* A first selling option from the MRP, per base unit. */
const defaultSellOptions = (baseUnit, mrpPerBase) => {
  if (!(mrpPerBase > 0)) return [];
  return [{ label: quantityLabel(1, baseUnit), qty: 1, price: round(mrpPerBase, 2) }];
};

/* Validated selling options from a request. */
const parseSellOptions = (list, baseUnit, packUnits) =>
  (Array.isArray(list) ? list : [])
    .map((entry) => ({
      qty: Number(entry?.qty),
      price: Number(entry?.price),
      label: String(entry?.label || "").trim().slice(0, 40),
    }))
    .filter((entry) => entry.qty > 0 && entry.price >= 0 && Number.isFinite(entry.price))
    .slice(0, 12)
    .map((entry) => ({
      qty: round(entry.qty),
      price: round(entry.price, 2),
      label: entry.label || quantityLabel(entry.qty, baseUnit, packUnits),
    }));

module.exports = {
  BASE_UNITS,
  packUnitsOf,
  suggestUnit,
  quantityLabel,
  defaultSellOptions,
  parseSellOptions,
  round,
};
