const sharp = require("sharp");
const logger = require("../utils/logger");
const { suggestUnit, defaultSellOptions } = require("./stockUnits");

/* ── Reading supplier bills with AI ───────────────────────────────────────
 * Bills arrive as phone photos — sideways, upside down, curled, with other
 * papers in the frame — and every supplier lays them out differently. So:
 *
 *  1. Turn each page upright: four small copies (as shot, ¼, ½, ¾ turn) are
 *     shown to the model, which picks the one that reads normally and counts
 *     the item rows.
 *  2. Send the upright page at full detail. The model sees images at about
 *     1,500 × 32-px squares each, so a long bill is cut into overlapping
 *     strips (≈16 rows each) to keep small print readable.
 *  3. Read every printed number on each line (rate, whether it includes GST,
 *     discount % or ₹, taxable value, GST %, amount, free quantity) rather
 *     than one guessed rate, and work out the taxable value from whichever
 *     numbers agree with each other.
 *  4. Check the lines against the bill's own totals; if they don't add up,
 *     ask once more with the mismatch spelt out and keep the better reading.
 * ────────────────────────────────────────────────────────────────────────── */

const OPENAI_URL = "https://api.openai.com/v1/responses";
const aiModel = () => process.env.OPENAI_MODEL || "gpt-6-luna";
// The orientation check is a simple choice; a small fast model is enough.
const orientModel = () => process.env.OPENAI_ORIENT_MODEL || "gpt-6-luna";
const aiEnabled = () => Boolean(process.env.OPENAI_API_KEY);

const ROWS_PER_STRIP = 16;
const MAX_STRIPS = 4;

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const httpError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

/* ── OpenAI call ──────────────────────────────────────────────────────── */

const callModel = async ({ model, instructions, content, schema, schemaName, timeoutMs = 120000 }) => {
  const body = {
    model,
    instructions,
    input: [{ role: "user", content }],
    text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
  };
  // Reasoning models think before answering; a little is enough here and
  // keeps a bill to seconds rather than a minute.
  if (/^(gpt-5|o\d)/.test(model)) {
    body.reasoning = { effort: process.env.OPENAI_REASONING || "low" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(OPENAI_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw httpError(
      error.name === "AbortError"
        ? "Reading the bill took too long. Try again, or a clearer photo."
        : "Could not reach the AI service.",
      502,
    );
  } finally {
    clearTimeout(timer);
  }

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    logger.error("OpenAI request failed", { status: response.status, error: json?.error?.message });
    throw httpError(
      response.status === 401
        ? "The OpenAI key was refused. Check OPENAI_API_KEY."
        : response.status === 429
          ? "OpenAI limit reached or no credit left on the key. Try again later."
          : `The AI could not read this bill (${json?.error?.message || response.status}).`,
      502,
    );
  }

  let text = typeof json.output_text === "string" ? json.output_text : "";
  for (const item of json.output || []) {
    for (const part of item.content || []) {
      if (part.type === "refusal") throw httpError("The AI could not read this bill.", 422);
      if (!text && part.type === "output_text") text = part.text;
    }
  }
  try {
    return { data: JSON.parse(text), usage: json.usage || {} };
  } catch {
    throw httpError("The AI reply could not be understood. Try again.", 502);
  }
};

const addUsage = (total, usage) => ({
  input: (total.input || 0) + (usage.input_tokens || 0),
  output: (total.output || 0) + (usage.output_tokens || 0),
});

/* ── Images ───────────────────────────────────────────────────────────── */

const jpegDataUrl = async (image, maxSide, quality = 82) => {
  const buffer = await image
    .clone()
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
};

const ORIENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["upright", "itemRows", "isBill"],
  properties: {
    upright: { type: "string", enum: ["A", "B", "C", "D"] },
    itemRows: { type: "integer" },
    isBill: { type: "boolean" },
  },
};

// A, B, C, D = turned 0°, 90°, 180°, 270° clockwise.
const TURNS = { A: 0, B: 90, C: 180, D: 270 };

/* Upright copy of a photo and roughly how many item rows it has. */
const preparePhoto = async (buffer) => {
  const base = sharp(buffer, { failOn: "none" }).rotate(); // apply EXIF turn
  const normalised = await base.jpeg({ quality: 92 }).toBuffer();
  const thumbs = await Promise.all(
    Object.values(TURNS).map((angle) =>
      jpegDataUrl(sharp(normalised).rotate(angle), 640, 70),
    ),
  );

  const content = [
    {
      type: "input_text",
      text:
        "These are the same photo turned four ways: A, B, C, D. Which one shows the bill's text the right way up (horizontal lines of text, read left to right, not mirrored or upside down)? " +
        "Also count the item rows in the bill's main table (only goods lines, not headers or totals).",
    },
  ];
  Object.keys(TURNS).forEach((label, index) => {
    content.push({ type: "input_text", text: `Photo ${label}:` });
    content.push({ type: "input_image", image_url: thumbs[index], detail: "high" });
  });

  let angle = 0;
  let itemRows = 0;
  let usage = {};
  try {
    const result = await callModel({
      model: orientModel(),
      instructions: "You look at photos of printed bills and answer briefly in JSON.",
      content,
      schema: ORIENT_SCHEMA,
      schemaName: "orientation",
      timeoutMs: 45000,
    });
    angle = TURNS[result.data.upright] || 0;
    itemRows = Math.max(0, Number(result.data.itemRows) || 0);
    usage = result.usage;
  } catch (error) {
    // Reading can still work on the photo as shot.
    logger.warn("Bill orientation check failed", { error: error.message });
  }

  const upright = sharp(normalised).rotate(angle);
  const uprightBuffer = await upright.jpeg({ quality: 92 }).toBuffer();
  const meta = await sharp(uprightBuffer).metadata();
  return { buffer: uprightBuffer, width: meta.width, height: meta.height, angle, itemRows, usage };
};

/* The images to send for one page: the whole page, plus overlapping strips
 * when it has many rows. */
const pageImages = async (page, pageNumber, pageCount) => {
  const label = pageCount > 1 ? `Page ${pageNumber} of the photos` : "The bill";
  const strips = Math.min(MAX_STRIPS, Math.max(1, Math.ceil(page.itemRows / ROWS_PER_STRIP)));
  const parts = [];

  parts.push({ type: "input_text", text: `${label} — whole page:` });
  parts.push({
    type: "input_image",
    image_url: await jpegDataUrl(sharp(page.buffer), strips > 1 ? 1600 : 2048),
    detail: "high",
  });

  if (strips > 1) {
    const overlap = Math.round(page.height * 0.08);
    const stripHeight = Math.ceil((page.height + overlap * (strips - 1)) / strips);
    for (let index = 0; index < strips; index += 1) {
      const top = Math.max(0, Math.min(page.height - stripHeight, index * (stripHeight - overlap)));
      parts.push({
        type: "input_text",
        text: `${label} — close-up ${index + 1} of ${strips} (top to bottom; close-ups overlap, so a line may appear in two of them — list it once):`,
      });
      parts.push({
        type: "input_image",
        image_url: await jpegDataUrl(
          sharp(page.buffer).extract({ left: 0, top, width: page.width, height: Math.min(stripHeight, page.height - top) }),
          2048,
          88,
        ),
        detail: "high",
      });
    }
  }
  return { parts, strips };
};

/* ── What the model returns ───────────────────────────────────────────── */

const num = { type: ["number", "null"] };

const BILL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "supplierName", "supplierGstin", "supplierPhone", "invoiceNo", "invoiceDate",
    "pageInfo", "taxType", "lines", "taxableTotal", "cgstTotal", "sgstTotal",
    "igstTotal", "otherCharges", "lessDiscount", "roundOff", "billTotal", "readingNotes",
  ],
  properties: {
    supplierName: { type: "string" },
    supplierGstin: { type: "string" },
    supplierPhone: { type: "string" },
    invoiceNo: { type: "string" },
    invoiceDate: { type: "string", description: "YYYY-MM-DD or empty" },
    pageInfo: { type: "string", description: "e.g. '1 of 2' if printed, else empty" },
    taxType: { type: "string", enum: ["intra", "inter", "unknown"] },
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "sr", "printedName", "name", "hsnCode", "qty", "freeQty", "unit", "packSize",
          "mrp", "sellingPrice", "rate", "rateIncludesGst", "discountPercent", "discountAmount",
          "taxable", "gstRate", "gstAmount", "amount", "category",
        ],
        properties: {
          sr: { type: ["integer", "null"] },
          printedName: { type: "string" },
          name: { type: "string" },
          hsnCode: { type: "string" },
          qty: num,
          freeQty: num,
          unit: { type: "string" },
          packSize: num,
          mrp: num,
          sellingPrice: num,
          rate: num,
          rateIncludesGst: { type: "boolean" },
          discountPercent: num,
          discountAmount: num,
          taxable: num,
          gstRate: num,
          gstAmount: num,
          amount: num,
          category: { type: "string" },
        },
      },
    },
    taxableTotal: num,
    cgstTotal: num,
    sgstTotal: num,
    igstTotal: num,
    otherCharges: num,
    lessDiscount: num,
    roundOff: num,
    billTotal: num,
    readingNotes: { type: "string" },
  },
};

const instructions = ({ shop, categories, shortNames }) =>
  [
    "You read Indian GST tax invoices that a bakery-café received from its suppliers, and return them as JSON.",
    "",
    `THE BUYER is ${shop.name}${shop.gstin ? ` (GSTIN ${shop.gstin})` : ""}. It appears as "Bill to", "Buyer", "Customer", "Consignee" or "Details of Receiver", often spelt loosely (Hindumata, Hindumathas, Hinduatha's). NEVER use the buyer as the supplier.`,
    "THE SUPPLIER is the business that issued the bill: its name is usually the large heading at the top, beside its own GSTIN, address and phone.",
    "Photos may contain parts of other bills or papers at the edges; read only the one bill that fills the photo.",
    "",
    "HEADER: invoiceNo exactly as printed (keep letters, slashes, dashes). invoiceDate as YYYY-MM-DD; Indian bills write day first (06/11/2026 = 2026-11-06, 12-Nov-26 = 2026-11-12). pageInfo like '1 of 2' if printed.",
    "taxType: intra if CGST+SGST are charged, inter if IGST.",
    "",
    "LINES: one entry per goods row in the item table, top to bottom, every row — do not skip any. Never include sub-total, tax, scheme summary, total or 'bottom scheme' rows as lines.",
    "- sr: the row's serial number if printed.",
    "- printedName: the description exactly as printed. name: the full, readable product name, expanding short forms (e.g. 'CDM SILK FN 129G' → 'Cadbury Dairy Milk Silk Fruit & Nut 129g').",
    "- hsnCode: digits only, as printed.",
    "- qty: billed quantity. If quantity is split into cases and pieces (CS / EA), give total pieces and the pack size. freeQty: free units in a FREE / FR / scheme column (0 if none).",
    "- unit: PCS, BOX, PKT, NOS, DISPLAY, POUCH, HANGER … as printed. packSize: pieces per unit when the name shows it (T24, 24x, 24(30x18.5g) → 24), else null.",
    "- mrp: MRP per billed unit. Take it from an MRP column; if there is none but the description shows it ('RS.45', 'MRP 1200/-', 'TICTAC MINT 20/-', '20/-  MRP 240'), use the price that matches the billed unit (the pack's MRP for a pack, e.g. MRP 240 for a hanger of 12 × 20/-). Null if not shown.",
    "- sellingPrice: only if the bill prints a separate retail selling price for the shop (not the supplier's rate), else null.",
    "- rate: the per-unit price column used to bill the line. rateIncludesGst: true when that column is marked 'Incl. of Tax' / inclusive, or is a dealer/MRP-style price from which the pre-tax rate is worked out. If the bill prints both an inclusive and an exclusive rate, give the EXCLUSIVE one with rateIncludesGst false (e.g. 'D.Price' or 'Rate (Incl. of Tax)' is inclusive; 'S.Rate', 'Rate', 'Price/Unit' beside it is usually exclusive — check: exclusive × (1 + GST%) ≈ inclusive).",
    "- discountPercent and discountAmount: the line's discount as printed (Disc %, Disc Amt, scheme, CD/RD, 'Disc+GST benefit' deductions). Null when not printed.",
    "- taxable: the line's taxable value as printed (after discount, before GST). Null if the bill doesn't print it.",
    "- gstRate: TOTAL GST % for the line (CGST 2.5 + SGST 2.5 = 5; '40.0' = 40). Use the bill's tax summary if lines don't show it.",
    "- gstAmount: total GST in ₹ for the line if printed (CGST amt + SGST amt).",
    "- amount: the line's final amount column as printed (whatever the bill calls Amount / Net Amt / Total).",
    "- Copy numbers exactly; ignore handwritten ticks and marks over the table.",
    "",
    "TOTALS: taxableTotal (sum of taxable values), cgstTotal, sgstTotal, igstTotal, otherCharges (freight/packing added), lessDiscount (amounts deducted from the final total that are NOT already in the lines, e.g. credit note), roundOff (negative if reduced), billTotal (final amount payable / Net Amount / Total). Null when not on this page.",
    "readingNotes: one short sentence on anything unclear (torn, faded, page missing), else empty.",
    "",
    "category: for each line choose the closest of the shop's categories below, or empty string:",
    ...categories.map((category) => `- ${category.name} (HSN ${category.hsnCode || "-"}, GST ${category.gstRate}%)`),
    ...(shortNames.length
      ? ["", "Short forms used on this shop's bills:", ...shortNames.map((entry) => `- ${entry.short} = ${entry.full}${entry.supplierName ? ` (on ${entry.supplierName} bills)` : ""}`)]
      : []),
  ].join("\n");

/* ── Making sense of the numbers ──────────────────────────────────────── */

// Two readings of one line agree within 50 paise or 0.3%.
const close = (left, right) => Math.abs(left - right) <= Math.max(0.5, Math.abs(right) * 0.003);
// A bill's totals must match within ₹1.50 (lines are often rounded).
const totalsClose = (left, right) => Math.abs(left - right) <= 1.5;

// GST slabs in use (incl. the small special rates).
const GST_SLABS = [0, 0.1, 0.25, 1.5, 3, 5, 12, 18, 28, 40];
const nearestSlab = (value) =>
  GST_SLABS.reduce((best, slab) => (Math.abs(slab - value) < Math.abs(best - value) ? slab : best), 0);

/* The line's GST %: as read when it is a real slab, otherwise (or when the
 * printed GST ₹ says otherwise) worked out from the GST ₹. */
const resolveGstRate = (line, fallbackGst) => {
  const read = line.gstRate === null || line.gstRate === undefined ? null : Number(line.gstRate);
  const gstAmount = Number(line.gstAmount) || 0;
  const amount = Number(line.amount) || 0;
  let derived = null;
  if (gstAmount > 0) {
    const base = Number(line.taxable) > 0 ? Number(line.taxable) : amount > gstAmount ? amount - gstAmount : 0;
    if (base > 0) {
      const raw = (gstAmount / base) * 100;
      const slab = nearestSlab(raw);
      if (Math.abs(slab - raw) <= Math.max(0.3, slab * 0.05)) derived = slab;
    }
  }
  if (read !== null && GST_SLABS.includes(read) && (derived === null || derived === read)) return read;
  if (derived !== null) return derived;
  if (read !== null) return nearestSlab(read);
  return fallbackGst;
};

/* Every way of reading a line's taxable value from its printed numbers.
 * Bills differ in whether the rate includes GST and whether "Amount" is
 * before or after GST, so each reading is kept and the bill as a whole
 * decides (see pickReadings). */
const lineReadings = (line, fallbackGst) => {
  const gstRate = resolveGstRate(line, fallbackGst);
  const qty = Number(line.qty) > 0 ? Number(line.qty) : 1;
  const factor = 1 + gstRate / 100;
  const printedRate = Number(line.rate) || 0;
  const amount = Number(line.amount) || 0;
  const gstAmount = Number(line.gstAmount) || 0;
  const discountFor = (gross) =>
    Number(line.discountAmount) > 0
      ? Number(line.discountAmount)
      : Number(line.discountPercent) > 0
        ? (gross * Number(line.discountPercent)) / 100
        : 0;
  const fromRate = (includesGst) => {
    if (!(printedRate > 0)) return null;
    const base = includesGst && gstRate ? printedRate / factor : printedRate;
    const gross = qty * base;
    return { taxable: gross - discountFor(gross), rate: base };
  };
  const asRead = fromRate(Boolean(line.rateIncludesGst));
  const flipped = gstRate ? fromRate(!line.rateIncludesGst) : null;

  const readings = {
    printed: Number(line.taxable) > 0 ? Number(line.taxable) : null,
    rateAsRead: asRead ? asRead.taxable : null,
    rateFlipped: flipped ? flipped.taxable : null,
    amountIsTaxable: amount > 0 ? amount : null,
    amountWithGst: amount > 0 && gstRate ? amount / factor : null,
    amountLessGst: amount > gstAmount && gstAmount > 0 ? amount - gstAmount : null,
    fromGstAmount: gstAmount > 0 && gstRate ? (gstAmount * 100) / gstRate : null,
  };

  // The value most readings agree with; earlier = more direct.
  const values = Object.values(readings).filter((value) => value !== null && value > 0);
  let vote = null;
  let votes = -1;
  values.forEach((value) => {
    const count = values.filter((other) => close(other, value)).length;
    if (count > votes) {
      vote = value;
      votes = count;
    }
  });

  return {
    qty,
    gstRate,
    rates: { rateAsRead: asRead?.rate ?? null, rateFlipped: flipped?.rate ?? null },
    // Whether the bill prints a discount for this line at all.
    hasDiscount: Number(line.discountAmount) > 0 || Number(line.discountPercent) > 0,
    readings,
    vote,
    votes,
    values: values.length,
  };
};

/* The final numbers for a line under one way of reading the bill. */
const settleLine = (info, strategy) => {
  const chosen = strategy === "vote" ? info.vote : info.readings[strategy] ?? info.vote;
  const taxable = round2(chosen || 0);
  const agreeing = Object.values(info.readings).filter(
    (value) => value !== null && value > 0 && close(value, taxable),
  ).length;

  // Store as pre-tax rate and ₹ discount that give exactly this taxable.
  // The pre-tax rate is whichever reading of the printed rate fits the
  // taxable value; a gap is only a discount if the bill prints one.
  const fits = (candidate) => candidate > 0 && close(info.qty * candidate, taxable);
  const baseRate = info.hasDiscount
    ? strategy === "rateFlipped"
      ? info.rates.rateFlipped
      : info.rates.rateAsRead ?? info.rates.rateFlipped
    : [info.rates.rateAsRead, info.rates.rateFlipped].find(fits) ?? taxable / info.qty;
  let rate = Math.round((baseRate || 0) * 10000) / 10000;
  let discount = round2(info.qty * rate - taxable);
  if (!info.hasDiscount) discount = 0;
  if (!(rate > 0) || discount < -0.05 || discount > info.qty * rate * 0.6) {
    rate = Math.round((taxable / info.qty) * 10000) / 10000;
    discount = 0;
  } else if (discount < 0) {
    discount = 0;
  }
  return {
    qty: info.qty,
    rate,
    discount,
    gstRate: info.gstRate,
    taxable,
    // Nothing else on the line backs this value up.
    check: info.values > 1 && agreeing < 2,
  };
};

const STRATEGIES = [
  "vote",
  "printed",
  "rateAsRead",
  "rateFlipped",
  "amountIsTaxable",
  "amountWithGst",
  "amountLessGst",
];

/* Choose the way of reading the lines whose totals match the bill's own
 * printed totals best; without printed totals, go by agreement per line. */
const pickReadings = (infos, reading) => {
  const taxableTotal = Number(reading.taxableTotal) > 0 ? Number(reading.taxableTotal) : null;
  const billTotal = Number(reading.billTotal) > 0 ? Number(reading.billTotal) : null;
  const extras =
    (Number(reading.otherCharges) || 0) - (Number(reading.lessDiscount) || 0) + (Number(reading.roundOff) || 0);
  const error = (lines) => {
    const taxable = lines.reduce((sum, line) => sum + line.taxable, 0);
    if (taxableTotal !== null) return Math.abs(taxable - taxableTotal);
    if (billTotal !== null) {
      const gst = lines.reduce((sum, line) => sum + (line.taxable * line.gstRate) / 100, 0);
      return Math.abs(taxable + gst + extras - billTotal);
    }
    return 0;
  };
  let best = null;
  STRATEGIES.forEach((strategy) => {
    const lines = infos.map((info) => settleLine(info, strategy));
    const off = error(lines);
    // "vote" wins ties: it is the most cautious per line.
    if (!best || off < best.off - 0.01) best = { strategy, lines, off };
  });
  return best;
};

const digits = (value) => String(value || "").replace(/\D/g, "");

/* The category for a line: the HSN code first (longest matching prefix,
 * then the GST rate), then the AI's choice. */
const categoryFor = (line, categories) => {
  const hsn = digits(line.hsnCode);
  if (hsn.length >= 4) {
    let longest = 0;
    let matches = [];
    categories.forEach((category) => {
      const prefixes = category.purchasePrefixes;
      prefixes.forEach((prefix) => {
        if (!hsn.startsWith(prefix)) return;
        if (prefix.length > longest) {
          longest = prefix.length;
          matches = [category];
        } else if (prefix.length === longest && !matches.includes(category)) {
          matches.push(category);
        }
      });
    });
    if (matches.length > 1) {
      const sameRate = matches.filter((category) => category.gstRate === line.gstRate);
      if (sameRate.length) matches = sameRate;
    }
    if (matches.length > 1) {
      const named = matches.find((category) => normalise(category.name) === normalise(line.category));
      if (named) return named;
    }
    if (matches.length >= 1) return matches[0];
  }
  return categories.find((category) => normalise(category.name) === normalise(line.category)) || null;
};

const normalise = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/* Extra HSN starts for the default categories that share 1905 or 2202. */
const BUILT_IN_PREFIXES = {
  "biscuit cookie": ["190531", "190532"],
  rusk: ["190540"],
  bread: ["19059010"],
};

const withPrefixes = (categories) =>
  categories.map((category) => ({
    ...category,
    purchasePrefixes: (category.hsnPrefixes?.length
      ? category.hsnPrefixes
      : [digits(category.hsnCode), ...(BUILT_IN_PREFIXES[normalise(category.name)] || [])]
    ).filter((prefix) => prefix.length >= 2),
  }));

/* Lines from overlapping close-ups appear twice; keep each row once. */
const dedupe = (lines) => {
  const seen = new Set();
  return lines.filter((line) => {
    const key =
      line.sr !== null && line.sr !== undefined
        ? `sr:${line.sr}:${normalise(line.printedName).slice(0, 12)}`
        : `n:${normalise(line.printedName || line.name)}:${line.qty}:${line.amount ?? line.taxable}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/* How far a reading is from its own printed totals (0 = adds up). */
const mismatch = (reading, lines) => {
  const taxable = lines.reduce((sum, line) => sum + line.taxable, 0);
  const gst = lines.reduce((sum, line) => sum + round2((line.taxable * line.gstRate) / 100), 0);
  const issues = [];
  let off = 0;
  if (Number(reading.taxableTotal) > 0 && !totalsClose(taxable, reading.taxableTotal)) {
    issues.push(`the lines' taxable values add up to ₹${round2(taxable)} but the bill's taxable total is ₹${reading.taxableTotal}`);
    off += Math.abs(taxable - reading.taxableTotal);
  }
  if (Number(reading.billTotal) > 0) {
    const total =
      taxable + gst + (Number(reading.otherCharges) || 0) - (Number(reading.lessDiscount) || 0) + (Number(reading.roundOff) || 0);
    if (!totalsClose(total, reading.billTotal)) {
      issues.push(`taxable ₹${round2(taxable)} + GST ₹${round2(gst)} gives ₹${round2(total)} but the bill total is ₹${reading.billTotal}`);
      off += Math.abs(total - reading.billTotal);
    }
  }
  return { off, issues, taxable: round2(taxable), gst: round2(gst) };
};

/* ── Reading a bill ───────────────────────────────────────────────────── */

const readBill = async ({ files, sheetText, categories, shop, shortNames, knownItem }) => {
  if (!aiEnabled()) {
    throw httpError("AI reading is not set up. Add OPENAI_API_KEY to the backend settings.", 503);
  }
  const started = Date.now();
  let usage = {};
  const photos = files.filter((file) => file.mimetype.startsWith("image/"));
  const pdfs = files.filter((file) => file.mimetype === "application/pdf" || /\.pdf$/i.test(file.originalname || ""));

  // 1–2. Upright pages, cut into strips where long.
  const pages = await Promise.all(photos.map((file) => preparePhoto(file.buffer)));
  pages.forEach((page) => {
    usage = addUsage(usage, page.usage);
  });
  const content = [
    {
      type: "input_text",
      text:
        files.length > 1
          ? `Read this supplier bill. It is ${files.length} photos/files of the same bill (pages in order); return ONE combined result with every line from every page.`
          : "Read this supplier bill.",
    },
  ];
  let stripCount = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const { parts, strips } = await pageImages(pages[index], index + 1, files.length);
    stripCount += strips;
    content.push(...parts);
  }
  pdfs.forEach((file) => {
    content.push({
      type: "input_file",
      filename: file.originalname || "bill.pdf",
      file_data: `data:application/pdf;base64,${file.buffer.toString("base64")}`,
    });
  });
  if (sheetText) {
    content.push({ type: "input_text", text: `Spreadsheet rows (tab separated):\n${String(sheetText).slice(0, 60000)}` });
  }
  if (content.length === 1) throw httpError("Upload a photo, PDF, Excel or CSV of the bill.", 400);

  const prefixed = withPrefixes(categories);
  const prompt = instructions({ shop, categories, shortNames });
  const model = aiModel();

  const interpret = (reading) => {
    const lines = dedupe(reading.lines || [])
      .filter((line) => String(line.printedName || line.name || "").trim())
      .map((line) => {
        const known = knownItem(line.printedName || line.name, reading.supplierName, line.name);
        const guessGst =
          line.gstRate === null || line.gstRate === undefined
            ? known?.gstRate ?? categoryFor({ ...line, gstRate: null }, prefixed)?.gstRate ?? 0
            : Number(line.gstRate) || 0;
        const info = lineReadings(line, guessGst);
        const category =
          (known?.categoryId && prefixed.find((entry) => entry.id === known.categoryId)) ||
          categoryFor({ ...line, gstRate: info.gstRate }, prefixed);
        // Which unit the line is in, and how many stock units that is.
        const packSize = Number(line.packSize) > 0 ? Number(line.packSize) : known?.packSize ?? null;
        const printedUnit = String(line.unit || known?.unit || "").trim().slice(0, 20);
        const units = suggestUnit(
          { unit: printedUnit, packSize },
          known?.stockItemId ? { baseUnit: known.baseUnit, packUnits: known.packUnits } : null,
        );
        // The same supplier unit as last time keeps last time's size.
        if (known?.unitFactor > 0 && known.unit && known.unit.toLowerCase() === printedUnit.toLowerCase()) {
          units.unitFactor = known.unitFactor;
        }
        // Unknown pack size (a bag with no count printed) → no per-unit
        // prices until the person enters it.
        const size = units.unitFactor > 0 ? units.unitFactor : null;
        const mrp =
          Number(line.mrp) > 0
            ? Number(line.mrp)
            : known?.mrpPerBase > 0 && size
              ? round2(known.mrpPerBase * size)
              : null;
        const sellOptions = known?.sellOptions?.length
          ? known.sellOptions
          : !size
            ? []
            : Number(line.sellingPrice) > 0
              ? defaultSellOptions(units.baseUnit, Number(line.sellingPrice) / size)
              : defaultSellOptions(units.baseUnit, mrp ? mrp / size : 0);
        return {
          printedName: String(line.printedName || line.name).trim().slice(0, 160),
          name: String(known?.name || line.name || line.printedName).trim().slice(0, 120),
          hsnCode: digits(line.hsnCode) || known?.hsnCode || category?.hsnCode || "",
          categoryId: category?.id || "",
          category: category?.name || "",
          unit: units.unit,
          baseUnit: units.baseUnit,
          unitFactor: units.unitFactor,
          packUnits: known?.packUnits || [],
          packSize,
          // MRP per billed unit, as printed (or from the item last time).
          mrp,
          // How the shop sells it: last time's options, else 1 unit at MRP.
          sellOptions,
          freeQty: Number(line.freeQty) > 0 ? Number(line.freeQty) : 0,
          printedAmount: Number(line.amount) > 0 ? Number(line.amount) : null,
          known: Boolean(known),
          // The stock item this line adds to; empty = a new item.
          stockItemId: known?.stockItemId || "",
          stockName: known?.stockName || "",
          stockQty: known?.stockQty ?? null,
          info,
        };
      });
    const picked = pickReadings(lines.map((line) => line.info), reading);
    const settled = lines.map(({ info, ...line }, index) => ({ ...line, ...picked.lines[index] }));
    return { reading, lines: settled, strategy: picked.strategy, check: mismatch(reading, settled) };
  };

  // 3. Read.
  const first = await callModel({ model, instructions: prompt, content, schema: BILL_SCHEMA, schemaName: "supplier_bill" });
  usage = addUsage(usage, first.usage);
  let best = interpret(first.data);
  let attempts = 1;

  // 4. One more look when the lines don't add up to the bill's own totals,
  //    or clearly fewer lines came back than the page has.
  const expectedRows = pages.reduce((sum, page) => sum + page.itemRows, 0);
  const missingRows = expectedRows > 0 && best.lines.length < expectedRows - 1;
  if (best.check.issues.length || missingRows) {
    const problems = [...best.check.issues];
    if (missingRows) problems.push(`only ${best.lines.length} lines were returned but the table seems to have about ${expectedRows} rows`);
    const retry = await callModel({
      model,
      instructions: prompt,
      content: [
        ...content,
        {
          type: "input_text",
          text:
            `A first reading of this bill does not add up: ${problems.join("; ")}. ` +
            "Read the bill again carefully, row by row, checking each line's quantity, rate, discount, taxable value and GST against the printed numbers and totals, and return the complete corrected JSON. " +
            `First reading for reference: ${JSON.stringify(first.data).slice(0, 20000)}`,
        },
      ],
      schema: BILL_SCHEMA,
      schemaName: "supplier_bill",
    }).catch((error) => {
      logger.warn("Bill re-read failed", { error: error.message });
      return null;
    });
    if (retry) {
      usage = addUsage(usage, retry.usage);
      attempts = 2;
      const second = interpret(retry.data);
      const score = (entry) => entry.check.off + Math.max(0, expectedRows - 1 - entry.lines.length) * 50;
      if (score(second) < score(best)) best = second;
    }
  }

  const { reading, lines, check } = best;
  const supplierGstin = String(reading.supplierGstin || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  const shopGstin = String(shop.gstin || "").toUpperCase();
  // A supplier in the same state charges CGST + SGST.
  let taxType = reading.taxType === "inter" ? "inter" : "intra";
  if (reading.taxType === "unknown" && supplierGstin.length >= 2 && shopGstin.length >= 2) {
    taxType = supplierGstin.slice(0, 2) === shopGstin.slice(0, 2) ? "intra" : "inter";
  }

  // Round off is often not printed; when the lines match the total within
  // a rupee, the difference is the round off.
  let roundOff = Number(reading.roundOff) || 0;
  const billTotal = Number(reading.billTotal) > 0 ? round2(reading.billTotal) : null;
  const beforeRound =
    check.taxable + check.gst + (Number(reading.otherCharges) || 0) - (Number(reading.lessDiscount) || 0);
  if (billTotal !== null && Math.abs(billTotal - beforeRound) < 1) {
    roundOff = round2(billTotal - beforeRound);
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  logger.info("Supplier bill read", {
    model,
    pages: files.length,
    strips: stripCount,
    lines: lines.length,
    attempts,
    adds: !check.issues.length,
    inputTokens: usage.input,
    outputTokens: usage.output,
    seconds,
  });

  return {
    draft: {
      supplierName: String(reading.supplierName || "").trim(),
      supplierGstin,
      supplierPhone: String(reading.supplierPhone || "").trim(),
      invoiceNo: String(reading.invoiceNo || "").trim(),
      dateKey: /^\d{4}-\d{2}-\d{2}$/.test(reading.invoiceDate || "") ? reading.invoiceDate : "",
      taxType,
      lines,
      otherCharges: round2(reading.otherCharges || 0),
      lessDiscount: round2(reading.lessDiscount || 0),
      roundOff: round2(roundOff),
      billTotal,
      pageInfo: reading.pageInfo || "",
    },
    review: {
      addsUp: !check.issues.length,
      issues: check.issues,
      notes: reading.readingNotes || "",
      linesToCheck: lines.filter((line) => line.check).length,
      expectedRows,
    },
    meta: { model, attempts, seconds, usage, pages: files.length, strips: stripCount, strategy: best.strategy },
    // The model's own reading, for testing; not sent to the browser.
    raw: reading,
  };
};

module.exports = {
  aiEnabled,
  aiModel,
  readBill,
  lineReadings,
  pickReadings,
  categoryFor,
  withPrefixes,
  normalise,
};
