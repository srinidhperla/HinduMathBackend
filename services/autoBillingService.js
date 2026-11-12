/* ── Auto Billing ─────────────────────────────────────────────────────────
 * Input: one day's takings — a list of PhonePe transaction amounts and the
 * cash total from the drawer. Output: bills whose totals match those amounts
 * exactly, filled with a believable mix of items from the billing catalog.
 *
 *   - each PhonePe transaction becomes one bill for exactly that amount
 *   - the cash total is split into several walk-in sized bills
 *
 * Item selection is an exact-sum search: a reachability table over the item
 * prices says which amounts can be made, then a weighted random walk back
 * from the target picks the items. When an amount cannot be made exactly
 * (e.g. ₹137 with prices in steps of 5) the bill is built slightly above it
 * and the difference is recorded as a discount, so the total still matches.
 * ────────────────────────────────────────────────────────────────────────── */

const MAX_BILL_AMOUNT = 50000;
const MAX_BILLS = 500;

const randomBetween = (min, max) => min + Math.random() * (max - min);
const randomInt = (min, max) => Math.floor(randomBetween(min, max + 1));

const gaussian = () => {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const weightedPick = (entries, weights) => {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = Math.random() * total;
  for (let index = 0; index < entries.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) return entries[index];
  }
  return entries[entries.length - 1];
};

/* Flattens the catalog into the pool of things a walk-in customer buys. */
const buildPool = (catalog, options = {}) => {
  const categories = new Set(
    (options.categories || []).map((entry) => String(entry).toLowerCase()),
  );
  const excluded = new Set((options.excludeIds || []).map(String));
  const pool = [];

  catalog.forEach((item) => {
    if (!item.billable || excluded.has(item.id)) return;
    if (categories.size && !categories.has(String(item.category).toLowerCase())) {
      return;
    }

    item.variants.forEach((variant) => {
      const price = Number(variant.price);
      if (!Number.isInteger(price) || price <= 0) return;

      // How often this shows up on a counter bill, relative to the rest.
      let weight = 1;
      if (item.isAddon) weight = 0.2;
      else if (price >= 600) weight = 0.35;
      else if (price >= 300) weight = 0.6;

      pool.push({
        id: `${item.id}|${variant.key}`,
        productId: item.id,
        variantKey: variant.key,
        name: item.name,
        variant: variant.label,
        price,
        weight,
      });
    });
  });

  return pool;
};

const plannedLineCount = (amount) => {
  if (amount < 80) return randomInt(1, 2);
  if (amount < 250) return randomInt(1, 3);
  if (amount < 600) return randomInt(2, 4);
  if (amount < 1500) return randomInt(2, 6);
  return randomInt(3, 8);
};

/* Picks items summing exactly to `amount`, or to the nearest makeable amount
 * above it (the gap becomes the bill's discount). */
const pickItems = (amount, pool, maxQtyPerItem = 4) => {
  const minPrice = Math.min(...pool.map((entry) => entry.price));
  const limit = amount + minPrice;

  const reachable = new Uint8Array(limit + 1);
  reachable[0] = 1;
  for (let value = 1; value <= limit; value += 1) {
    for (let index = 0; index < pool.length; index += 1) {
      const price = pool[index].price;
      if (price <= value && reachable[value - price]) {
        reachable[value] = 1;
        break;
      }
    }
  }

  let target = amount;
  while (target <= limit && !reachable[target]) target += 1;

  const planned = plannedLineCount(target);
  const quantities = new Map();
  let remaining = target;
  let steps = 0;

  while (remaining > 0) {
    const fits = pool.filter(
      (entry) => entry.price <= remaining && reachable[remaining - entry.price],
    );
    const underCap = fits.filter(
      (entry) => (quantities.get(entry.id) || 0) < maxQtyPerItem,
    );
    const candidates = underCap.length ? underCap : fits;

    // Aim each pick at "what is left ÷ picks still planned", so a ₹900 bill
    // is a cake and a few extras rather than thirty-six cream buns.
    const ideal = remaining / Math.max(1, planned - steps);
    const weights = candidates.map(
      (entry) =>
        entry.weight *
        Math.exp(-1.4 * Math.abs(Math.log(entry.price / ideal))) *
        (quantities.has(entry.id) ? 1.25 : 1),
    );

    const choice = weightedPick(candidates, weights);
    quantities.set(choice.id, (quantities.get(choice.id) || 0) + 1);
    remaining -= choice.price;
    steps += 1;
  }

  const byId = new Map(pool.map((entry) => [entry.id, entry]));
  const lines = [...quantities.entries()].map(([id, qty]) => {
    const entry = byId.get(id);
    return {
      productId: entry.productId,
      variantKey: entry.variantKey,
      name: entry.name,
      variant: entry.variant,
      qty,
      unitPrice: entry.price,
      lineTotal: entry.price * qty,
    };
  });

  return { lines, subTotal: target, discount: target - amount };
};

/* Splits the cash total into walk-in sized bill amounts (multiples of ₹5
 * where the total allows) that add up to exactly `total`. */
const splitCash = (total, options = {}) => {
  const minBill = Math.max(5, Number(options.minBill) || 40);
  const maxBill = Math.max(minBill, Number(options.maxBill) || 900);
  const avgBill = Math.min(maxBill, Math.max(minBill, Number(options.avgBill) || 180));

  let count = Number(options.count) > 0
    ? Math.round(Number(options.count))
    : Math.round(total / (avgBill * randomBetween(0.9, 1.1)));
  count = Math.max(1, Math.min(count, MAX_BILLS, Math.floor(total / minBill) || 1));
  // Not enough bills to stay under maxBill → add more.
  count = Math.max(count, Math.min(MAX_BILLS, Math.ceil(total / maxBill)));

  const weights = Array.from({ length: count }, () => Math.exp(gaussian() * 0.55));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);

  const amounts = weights.map((weight) => {
    const raw = (weight / weightSum) * total;
    const stepped = Math.round(raw / 5) * 5;
    return Math.min(maxBill, Math.max(minBill, stepped));
  });

  // Nudge random bills by ₹5 until the split adds up; whatever cannot be
  // placed within the min/max bounds lands on the largest/smallest bill.
  let difference = total - amounts.reduce((sum, amount) => sum + amount, 0);
  let guard = count * 400;
  while (Math.abs(difference) >= 5 && guard > 0) {
    guard -= 1;
    const index = randomInt(0, count - 1);
    const step = difference > 0 ? 5 : -5;
    const next = amounts[index] + step;
    if (next < minBill || next > maxBill) continue;
    amounts[index] = next;
    difference -= step;
  }

  if (difference !== 0) {
    const index =
      difference > 0
        ? amounts.indexOf(Math.min(...amounts))
        : amounts.indexOf(Math.max(...amounts));
    amounts[index] += difference;
  }

  return amounts.filter((amount) => amount > 0);
};

const toMinutes = (time) => {
  const [hours, minutes] = String(time).split(":").map(Number);
  return hours * 60 + minutes;
};

const toTime = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const randomTime = (startTime, endTime) => {
  const start = toMinutes(startTime);
  const end = Math.max(start + 1, toMinutes(endTime));
  return toTime(randomInt(start, end - 1));
};

/* Builds the full preview. Nothing is saved here. */
const generateBills = ({ catalog, phonepe = [], cashTotal = 0, options = {} }) => {
  const pool = buildPool(catalog, options);
  if (!pool.length) {
    throw Object.assign(
      new Error("No billing items match the selected categories."),
      { statusCode: 400 },
    );
  }

  const startTime = options.startTime || "09:00";
  const endTime = options.endTime || "22:00";
  const maxQty = Math.max(1, Math.min(20, Number(options.maxQtyPerItem) || 4));

  const requests = [];

  phonepe.forEach((entry) => {
    requests.push({
      mode: "phonepe",
      amount: entry.amount,
      time: entry.time || randomTime(startTime, endTime),
      reference: entry.reference || "",
    });
  });

  if (cashTotal > 0) {
    splitCash(cashTotal, options).forEach((amount) => {
      requests.push({
        mode: "cash",
        amount,
        time: randomTime(startTime, endTime),
        reference: "",
      });
    });
  }

  if (requests.length > MAX_BILLS) {
    throw Object.assign(
      new Error(`That would create ${requests.length} bills; the limit is ${MAX_BILLS} per run.`),
      { statusCode: 400 },
    );
  }

  return requests
    .map((request, index) => {
      // Paise (₹250.50) are matched by building to the next rupee and
      // discounting the difference.
      const picked = pickItems(Math.ceil(request.amount), pool, maxQty);
      return {
        tempId: `auto-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
        ...request,
        lines: picked.lines,
        subTotal: picked.subTotal,
        discount: Math.round((picked.subTotal - request.amount) * 100) / 100,
        grandTotal: request.amount,
      };
    })
    .sort((left, right) => left.time.localeCompare(right.time));
};

module.exports = { generateBills, MAX_BILL_AMOUNT, MAX_BILLS };
