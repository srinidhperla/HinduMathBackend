const { isValueCategory, valueCandidates, fail } = require("./billingService");

/* ── Auto Billing ─────────────────────────────────────────────────────────
 * Input for one day:
 *   - the PhonePe transactions (each becomes ONE bill for exactly its amount)
 *   - the cash amount, and how many bills the day should have in total
 *     (cash bills = total bills − PhonePe transactions)
 *   - optional amounts per billing category ("Bread ₹500")
 *
 * Output: bills whose item lines add up to each bill's amount exactly — there
 * is no discount or round-off line anywhere.
 *
 * How it works:
 *   1. Every sellable thing is a "unit" with a whole-rupee price: an item
 *      size (Milk bread 300g ₹45) or one allowed amount of a category that
 *      has no items (Chocolates ₹20).
 *   2. For each category given an amount, units of that category are picked
 *      to add up to that amount (or the closest the prices allow). These
 *      units MUST all be used, spread across the day's bills.
 *   3. Those units are dealt out to the bills. What is still missing on each
 *      bill is then filled from the other categories.
 *   4. A bill can only be completed if its missing amount can be made from
 *      the remaining units. When it cannot, units are moved between bills —
 *      and for cash bills a few rupees are shifted from one bill to another —
 *      until every bill can be completed. A bill that still cannot be made
 *      is returned flagged, never silently adjusted.
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

const shuffle = (list) => {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = randomInt(0, index);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
};

/* ── Units ──────────────────────────────────────────────────────────────── */

const buildUnits = (catalog, categories) => {
  const units = [];

  catalog.forEach((item) => {
    if (!item.billable) return;
    item.variants.forEach((variant) => {
      const price = Number(variant.price);
      if (!Number.isInteger(price) || price <= 0) return;

      // How often this turns up on a counter bill, relative to the rest.
      let weight = 1;
      if (item.isAddon) weight = 0.2;
      else if (price >= 600) weight = 0.35;
      else if (price >= 300) weight = 0.6;

      units.push({
        id: `item|${item.id}|${variant.key}`,
        kind: "item",
        productId: item.id,
        variantKey: variant.key,
        categoryId: item.billingCategoryId || "",
        name: item.name,
        variant: variant.label,
        price,
        weight,
      });
    });
  });

  categories.filter(isValueCategory).forEach((category) => {
    valueCandidates(category).forEach((price) => {
      units.push({
        id: `value|${category.id}|${price}`,
        kind: "value",
        productId: "",
        variantKey: "",
        categoryId: category.id,
        name: category.name,
        variant: "",
        price,
        // A category line fills gaps; it should not crowd out real items.
        weight: 0.4,
      });
    });
  });

  return units;
};

/* reach[v] === 1 when some multiset of `prices` adds up to exactly v. */
const reachTable = (prices, limit) => {
  const unique = [...new Set(prices)].sort((left, right) => left - right);
  const reach = new Uint8Array(limit + 1);
  reach[0] = 1;
  for (let value = 1; value <= limit; value += 1) {
    for (let index = 0; index < unique.length; index += 1) {
      const price = unique[index];
      if (price > value) break;
      if (reach[value - price]) {
        reach[value] = 1;
        break;
      }
    }
  }
  return reach;
};

/* Picks units adding up to exactly `amount` (which must be reachable).
 * Returns a flat list, one entry per unit sold. */
const pickExact = (amount, pool, reach, { plannedLines, maxQty }) => {
  const quantities = new Map();
  const picked = [];
  let remaining = amount;
  let steps = 0;

  while (remaining > 0) {
    const fits = pool.filter(
      (unit) => unit.price <= remaining && reach[remaining - unit.price],
    );
    const underCap = fits.filter(
      (unit) => (quantities.get(unit.id) || 0) < maxQty,
    );
    const candidates = underCap.length ? underCap : fits;

    // Aim each pick at "what is left ÷ picks still planned", so a ₹900 bill
    // is a cake and a few extras rather than thirty-six cream buns.
    const ideal = remaining / Math.max(1, plannedLines - steps);
    const weights = candidates.map(
      (unit) =>
        unit.weight *
        Math.exp(-1.4 * Math.abs(Math.log(unit.price / ideal))) *
        (quantities.has(unit.id) ? 1.25 : 1),
    );

    const choice = weightedPick(candidates, weights);
    quantities.set(choice.id, (quantities.get(choice.id) || 0) + 1);
    picked.push(choice);
    remaining -= choice.price;
    steps += 1;
  }

  return picked;
};

const plannedLineCount = (amount) => {
  if (amount < 80) return randomInt(1, 2);
  if (amount < 250) return randomInt(1, 3);
  if (amount < 600) return randomInt(2, 4);
  if (amount < 1500) return randomInt(2, 6);
  return randomInt(3, 8);
};

/* ── Cash split ─────────────────────────────────────────────────────────── */

const splitCash = (total, count) => {
  const average = total / count;
  const minBill = Math.max(5, Math.min(40, Math.floor(average / 2)));
  const maxBill = Math.max(900, Math.ceil(average * 3));

  const weights = Array.from({ length: count }, () =>
    Math.exp(gaussian() * 0.55),
  );
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);

  const amounts = weights.map((weight) => {
    const stepped = Math.round(((weight / weightSum) * total) / 5) * 5;
    return Math.min(maxBill, Math.max(minBill, stepped));
  });

  // Nudge random bills by ₹5 until the split adds up; whatever cannot be
  // placed within the bounds lands on one bill.
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

  return { amounts, minBill };
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

/* ── Category amounts ───────────────────────────────────────────────────── */

/* Units of one category adding up to `target`, or to the closest amount its
 * prices allow (looking below the target first, so the day never overshoots
 * by more than it has to). */
const composeCategory = (target, categoryUnits) => {
  const minPrice = Math.min(...categoryUnits.map((unit) => unit.price));
  const limit = target + minPrice;
  const reach = reachTable(
    categoryUnits.map((unit) => unit.price),
    limit,
  );

  let amount = -1;
  for (let distance = 0; distance <= limit; distance += 1) {
    if (target - distance > 0 && reach[target - distance]) {
      amount = target - distance;
      break;
    }
    if (target + distance <= limit && reach[target + distance]) {
      amount = target + distance;
      break;
    }
  }
  if (amount <= 0) return { amount: 0, units: [] };

  const prices = categoryUnits
    .map((unit) => unit.price)
    .sort((left, right) => left - right);
  const median = prices[Math.floor(prices.length / 2)];

  return {
    amount,
    units: pickExact(amount, categoryUnits, reach, {
      plannedLines: Math.max(1, Math.round(amount / median)),
      maxQty: Infinity,
    }),
  };
};

/* ── Placement ──────────────────────────────────────────────────────────── */

const gapOf = (bill) =>
  bill.amount - bill.units.reduce((sum, unit) => sum + unit.price, 0);

const makePlanner = (freeReach) => {
  // A bill can be completed when what is missing is zero or can be made
  // from the free units. Paise can never be made from whole-rupee prices.
  const canComplete = (gap) =>
    Number.isInteger(gap) &&
    gap >= 0 &&
    (gap === 0 || (gap < freeReach.length && freeReach[gap] === 1));

  const isGood = (bill) => canComplete(gapOf(bill));

  /* Makes room for a unit that fits no bill by enlarging one cash bill with
   * rupees taken from other cash bills (cash bill sizes are ours to choose;
   * only their total is fixed). Returns the enlarged bill, or null. */
  const makeRoom = (bills, unit, minCashBill) => {
    const cashBills = bills.filter((bill) => bill.mode === "cash");
    if (cashBills.length < 2) return null;

    const receiver = cashBills.reduce((best, bill) =>
      gapOf(bill) > gapOf(best) ? bill : best,
    );
    let needed = unit.price - gapOf(receiver);

    const donors = cashBills
      .filter((bill) => bill !== receiver)
      .map((bill) => ({
        bill,
        spare: Math.min(gapOf(bill), bill.amount - minCashBill),
      }))
      .filter((donor) => donor.spare > 0)
      .sort((left, right) => right.spare - left.spare);

    const available = donors.reduce((sum, donor) => sum + donor.spare, 0);
    if (available < needed) return null;

    for (const donor of donors) {
      if (needed <= 0) break;
      const taken = Math.min(donor.spare, needed);
      donor.bill.amount -= taken;
      receiver.amount += taken;
      needed -= taken;
    }
    return receiver;
  };

  /* Deals the must-use units out to the bills. Returns false when some unit
   * does not fit anywhere. */
  const deal = (bills, units, minCashBill) => {
    // Units locked onto a bill (see lockUnitsForHardBills) stay where they are.
    bills.forEach((bill) => {
      bill.units = bill.units.filter((unit) => unit.locked);
    });

    const ordered = shuffle(units).sort(
      (left, right) => right.price - left.price,
    );

    for (const unit of ordered) {
      const candidates = bills.filter((bill) => gapOf(bill) >= unit.price);
      if (!candidates.length) {
        const receiver = makeRoom(bills, unit, minCashBill);
        if (!receiver) return false;
        receiver.units.push(unit);
        continue;
      }
      const choice = weightedPick(
        candidates,
        candidates.map((bill) => {
          const gap = gapOf(bill);
          // Prefer placements that leave the bill completable.
          return gap * (canComplete(gap - unit.price) ? 4 : 1);
        }),
      );
      choice.units.push(unit);
    }
    return true;
  };

  /* Tries to make `bill` completable by moving one unit in or out, or (cash
   * bills only) shifting a few rupees to or from another cash bill. */
  const repair = (bill, bills, minCashBill) => {
    const others = shuffle(bills.filter((other) => other !== bill));

    // Move one of this bill's units to another bill.
    for (const unit of shuffle(bill.units)) {
      if (unit.locked) continue;
      if (!canComplete(gapOf(bill) + unit.price)) continue;
      for (const other of others) {
        const otherGap = gapOf(other);
        if (otherGap >= unit.price && canComplete(otherGap - unit.price)) {
          bill.units.splice(bill.units.indexOf(unit), 1);
          other.units.push(unit);
          return true;
        }
      }
    }

    // Pull a unit in from another bill.
    for (const other of others) {
      for (const unit of shuffle(other.units)) {
        const gap = gapOf(bill);
        if (
          !unit.locked &&
          gap >= unit.price &&
          canComplete(gap - unit.price) &&
          canComplete(gapOf(other) + unit.price)
        ) {
          other.units.splice(other.units.indexOf(unit), 1);
          bill.units.push(unit);
          return true;
        }
      }
    }

    // Cash bills are ours to size: shift a few rupees between two of them.
    if (bill.mode === "cash") {
      const gap = gapOf(bill);
      for (let delta = 1; delta <= 400; delta += 1) {
        for (const signed of [delta, -delta]) {
          if (bill.amount + signed < minCashBill) continue;
          if (!canComplete(gap + signed)) continue;
          for (const other of others) {
            if (other.mode !== "cash") continue;
            if (other.amount - signed < minCashBill) continue;
            if (canComplete(gapOf(other) - signed)) {
              bill.amount += signed;
              other.amount -= signed;
              return true;
            }
          }
        }
      }
    }

    return false;
  };

  return { isGood, deal, repair };
};

const mergeUnits = (units) => {
  const merged = new Map();
  units.forEach((unit) => {
    const line = merged.get(unit.id) || {
      productId: unit.productId,
      variantKey: unit.variantKey,
      categoryId: unit.categoryId,
      kind: unit.kind,
      // An open line is priced freely (gap filler); see resolveLines.
      open: unit.kind === "open",
      name: unit.name,
      variant: unit.variant,
      unitPrice: unit.price,
      qty: 0,
    };
    line.qty += 1;
    merged.set(unit.id, line);
  });
  return [...merged.values()].map((line) => ({
    ...line,
    lineTotal: line.qty * line.unitPrice,
  }));
};

/* ── The plan ───────────────────────────────────────────────────────────── */

const generatePlan = ({
  catalog,
  categories,
  phonepe = [],
  cashTotal = 0,
  totalBills,
  categoryTargets = [],
  options = {},
}) => {
  const startTime = options.startTime || "09:00";
  const endTime = options.endTime || "22:00";
  const maxQty = Math.max(1, Math.min(20, Number(options.maxQtyPerItem) || 4));

  const upiCount = phonepe.length;
  const cashBillCount = totalBills - upiCount;
  const upiTotal = phonepe.reduce((sum, entry) => sum + entry.amount, 0);
  const dayTotal = upiTotal + cashTotal;

  if (cashBillCount < 0) {
    throw fail(
      `You asked for ${totalBills} bills, but there are ${upiCount} PhonePe transactions and each needs its own bill.`,
    );
  }
  if (cashTotal > 0 && cashBillCount === 0) {
    throw fail(
      `All ${totalBills} bills are taken by PhonePe transactions, so there is no bill left for the ₹${cashTotal} cash. Increase the number of bills.`,
    );
  }
  if (cashTotal === 0 && cashBillCount > 0) {
    throw fail(
      `${totalBills} bills minus ${upiCount} PhonePe transactions leaves ${cashBillCount} cash bills, but the cash amount is ₹0.`,
    );
  }
  if (totalBills > MAX_BILLS) {
    throw fail(`At most ${MAX_BILLS} bills can be generated in one run.`);
  }

  const units = buildUnits(catalog, categories);
  if (!units.length) {
    throw fail("There are no billing items or category amounts to bill with.");
  }
  const cheapest = Math.min(...units.map((unit) => unit.price));
  if (cashBillCount > 0 && cashTotal / cashBillCount < cheapest) {
    throw fail(
      `₹${cashTotal} cash across ${cashBillCount} bills is under ₹${cheapest} a bill, which is less than your cheapest item.`,
    );
  }

  /* 1. The bills and their amounts. */
  const bills = phonepe.map((entry) => ({
    mode: "phonepe",
    amount: entry.amount,
    time: entry.time || randomTime(startTime, endTime),
    reference: entry.reference || "",
    units: [],
  }));

  const categoriesById = new Map(
    categories.map((category) => [category.id, category]),
  );

  let minCashBill = cheapest;
  if (cashBillCount > 0) {
    const split = splitCash(cashTotal, cashBillCount);
    minCashBill = Math.max(cheapest, Math.min(split.minBill, cheapest * 2));
    split.amounts.forEach((amount) => {
      bills.push({
        mode: "cash",
        amount,
        time: randomTime(startTime, endTime),
        reference: "",
        units: [],
      });
    });
  }

  /* 2. The amount each category must come to, and what is left over to fill
   *    the bills with ("free" units: every category without an amount). */
  const budgets = new Map();

  categoryTargets.forEach((target) => {
    const category = categoriesById.get(target.categoryId);
    if (!category) {
      throw fail(
        "One of the category amounts is for a category that no longer exists.",
      );
    }
    const categoryUnits = units.filter(
      (unit) => unit.categoryId === category.id,
    );
    if (!categoryUnits.length) {
      throw fail(
        `"${category.name}" has no items and no amounts set, so it cannot be billed. Add items or values to it in Categories & Tax.`,
      );
    }
    budgets.set(category.id, {
      category,
      units: categoryUnits,
      target: target.amount,
      remaining: target.amount,
      locked: 0,
    });
  });

  const targetTotal = [...budgets.values()].reduce(
    (sum, budget) => sum + budget.target,
    0,
  );
  if (targetTotal > dayTotal) {
    throw fail(
      `The category amounts add up to ₹${targetTotal}, more than the day's total of ₹${dayTotal}.`,
    );
  }

  const freePool = units.filter((unit) => !budgets.has(unit.categoryId));
  const largest =
    Math.max(cashTotal, ...phonepe.map((entry) => Math.ceil(entry.amount))) + 500;
  const freeReach = reachTable(
    freePool.map((unit) => unit.price),
    Math.min(largest, MAX_BILL_AMOUNT + 500),
  );
  const planner = makePlanner(freeReach);

  /* 3. A PhonePe amount is fixed. When it cannot be made from the free units
   *    alone (₹64 when the only ₹64 item is in a category with an amount),
   *    one or two units from those categories are locked onto that bill and
   *    taken out of the category's amount. */
  const lockUnitsForHardBills = () => {
    const budgeted = [...budgets.values()];
    if (!budgeted.length) return;

    bills
      .filter((bill) => bill.mode === "phonepe" && !planner.isGood(bill))
      .forEach((bill) => {
        const amount = bill.amount;
        if (!Number.isInteger(amount)) return;

        const options = [];
        budgeted.forEach((budget) => {
          budget.units.forEach((unit) => {
            if (unit.price <= amount && unit.price <= budget.remaining) {
              options.push({ unit, budget });
            }
          });
        });

        const completes = (rest) =>
          rest === 0 ||
          (rest > 0 && rest < freeReach.length && freeReach[rest] === 1);

        // One unit, or a few of the same unit (₹311 = 4 × ₹64 + ₹55).
        for (let copies = 1; copies <= 6; copies += 1) {
          const fits = options.filter(
            ({ unit, budget }) =>
              unit.price * copies <= budget.remaining &&
              completes(amount - unit.price * copies),
          );
          if (fits.length) {
            const { unit, budget } = fits[randomInt(0, fits.length - 1)];
            for (let copy = 0; copy < copies; copy += 1) {
              bill.units.push({ ...unit, locked: true });
            }
            budget.remaining -= unit.price * copies;
            budget.locked += unit.price * copies;
            return;
          }
        }

        const shuffled = shuffle(options);
        for (const first of shuffled) {
          for (const second of shuffled) {
            const rest = amount - first.unit.price - second.unit.price;
            if (rest < 0) continue;
            const sameBudget = first.budget === second.budget;
            if (
              sameBudget &&
              first.unit.price + second.unit.price > first.budget.remaining
            ) {
              continue;
            }
            if (completes(rest)) {
              [first, second].forEach(({ unit, budget }) => {
                bill.units.push({ ...unit, locked: true });
                budget.remaining -= unit.price;
                budget.locked += unit.price;
              });
              return;
            }
          }
        }
      });
  };
  lockUnitsForHardBills();

  /* 4. Units making up the rest of each category amount. Which sizes a
   *    category is made of decides whether every bill can be completed (one
   *    ₹64 pack among ₹5-step prices leaves a bill ₹1 out), so each attempt
   *    below draws a fresh mix. */
  const lockedTotal = [...budgets.values()].reduce(
    (sum, budget) => sum + budget.locked,
    0,
  );

  const composeTargets = () => {
    const summaries = [];
    let mustUse = [];
    budgets.forEach((budget) => {
      const composed =
        budget.remaining > 0
          ? composeCategory(budget.remaining, budget.units)
          : { amount: 0, units: [] };
      mustUse = mustUse.concat(composed.units);
      summaries.push({
        categoryId: budget.category.id,
        name: budget.category.name,
        target: budget.target,
        generated: budget.locked + composed.amount,
      });
    });
    const total =
      lockedTotal + mustUse.reduce((sum, unit) => sum + unit.price, 0);
    return { mustUse, summaries, total };
  };

  /* 5. Deal the must-use units, then repair until every bill can be made. */
  let best = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const composed = composeTargets();
    if (composed.total > dayTotal) continue;

    const working = bills.map((bill) => ({ ...bill, units: [...bill.units] }));
    if (!planner.deal(working, composed.mustUse, minCashBill)) continue;

    for (let pass = 0; pass < 10; pass += 1) {
      const bad = working.filter((bill) => !planner.isGood(bill));
      if (!bad.length) break;
      bad.forEach((bill) => planner.repair(bill, working, minCashBill));
    }

    const badCount = working.filter((bill) => !planner.isGood(bill)).length;
    if (!best || badCount < best.badCount) {
      best = { bills: working, badCount, summaries: composed.summaries };
    }
    if (badCount === 0) break;
  }

  if (!best) {
    throw fail(
      "The category amounts could not be spread across the bills. Try more bills, or smaller category amounts.",
    );
  }
  const targetSummaries = best.summaries;

  /* 6. Fill what is missing on each bill from the other categories. A bill
   *    whose amount the prices cannot make (₹20 when the cheapest item is
   *    ₹25) gets one open line in the chosen gap category for the part the
   *    items cannot cover — when a gap category was chosen. */
  const gapCategory = options.gapCategoryId
    ? categoriesById.get(String(options.gapCategoryId))
    : null;
  if (options.gapCategoryId && !gapCategory) {
    throw fail("The category chosen for odd amounts no longer exists.");
  }

  const fillWithGapLine = (gap, plannedLines) => {
    // Split the gap into an items part the prices can make and a leftover
    // for the open line — ideally a believable ₹10–₹60, else the smallest.
    const whole = Math.floor(gap);
    let itemsPart = -1;
    for (let value = whole; value >= 0; value -= 1) {
      const leftover = gap - value;
      const makeable = value === 0 || (value < freeReach.length && freeReach[value] === 1);
      if (makeable && leftover >= 10 && leftover <= 60) {
        itemsPart = value;
        break;
      }
    }
    if (itemsPart < 0) {
      for (let value = whole; value >= 0; value -= 1) {
        const makeable = value === 0 || (value < freeReach.length && freeReach[value] === 1);
        if (makeable && gap - value > 0) {
          itemsPart = value;
          break;
        }
      }
    }
    const items =
      itemsPart > 0
        ? pickExact(itemsPart, freePool, freeReach, { plannedLines, maxQty })
        : [];
    const leftover = Math.round((gap - Math.max(0, itemsPart)) * 100) / 100;
    return [
      ...items,
      {
        id: `open|${gapCategory.id}|${leftover}`,
        kind: "open",
        productId: "",
        variantKey: "",
        categoryId: gapCategory.id,
        name: gapCategory.name,
        variant: "",
        price: leftover,
      },
    ];
  };

  let gapFilled = 0;
  const result = best.bills
    .map((bill, index) => {
      const gap = Math.round(gapOf(bill) * 100) / 100;
      const completable = planner.isGood(bill);
      const plannedLines = Math.max(
        1,
        plannedLineCount(bill.amount) - bill.units.length,
      );
      let filler = [];
      if (completable && gap > 0) {
        filler = pickExact(gap, freePool, freeReach, { plannedLines, maxQty });
      } else if (!completable && gap > 0 && gapCategory) {
        filler = fillWithGapLine(gap, plannedLines);
        gapFilled += 1;
      }
      const lines = mergeUnits([...bill.units, ...filler]);
      const itemsTotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);

      return {
        tempId: `auto-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
        mode: bill.mode,
        amount: bill.amount,
        time: bill.time,
        reference: bill.reference,
        lines,
        itemsTotal,
        // True when the items could not be made to equal the amount.
        needsFix: Math.abs(itemsTotal - bill.amount) > 0.001,
        shortBy: Math.round((bill.amount - itemsTotal) * 100) / 100,
      };
    })
    .sort((left, right) => left.time.localeCompare(right.time));

  /* 7. What each category came to across the whole day. */
  const generatedByCategory = new Map();
  result.forEach((bill) => {
    bill.lines.forEach((line) => {
      generatedByCategory.set(
        line.categoryId,
        (generatedByCategory.get(line.categoryId) || 0) + line.lineTotal,
      );
    });
  });

  return {
    bills: result,
    counts: {
      total: result.length,
      upi: upiCount,
      cash: cashBillCount,
      needsFix: result.filter((bill) => bill.needsFix).length,
      gapFilled,
    },
    totals: { upi: upiTotal, cash: cashTotal, day: dayTotal },
    targets: targetSummaries.map((target) => ({
      ...target,
      gap: target.generated - target.target,
    })),
    categoryTotals: [...generatedByCategory.entries()]
      .map(([categoryId, amount]) => ({
        categoryId,
        name: categoriesById.get(categoryId)?.name || "Uncategorised",
        amount,
      }))
      .sort((left, right) => right.amount - left.amount),
  };
};

module.exports = { generatePlan, MAX_BILL_AMOUNT, MAX_BILLS };
