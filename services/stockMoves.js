const mongoose = require("mongoose");
const StockItem = require("../models/BillingStockItem");
const logger = require("../utils/logger");

/* Sales and stock: a saved bill takes its stock items off stock; a cancelled
 * bill (or a reversed auto-billing run) puts them back. Each bill line holds
 * the stock item and the quantity in its stock unit, so this is exact even
 * if the item's selling options change later. Stock may go below zero —
 * a sale is never refused because a purchase bill hasn't been entered. */

const sumByItem = (bills) => {
  const totals = new Map();
  bills.forEach((bill) => {
    (bill.items || []).forEach((line) => {
      if (!line.stockItemId || !mongoose.isValidObjectId(line.stockItemId)) return;
      const qty = Number(line.stockQty) || 0;
      if (!qty) return;
      totals.set(line.stockItemId, (totals.get(line.stockItemId) || 0) + qty);
    });
  });
  return totals;
};

/* sign -1 = sold (take off stock), +1 = sale undone (put back). */
const moveStockForBills = async (bills, sign) => {
  const totals = sumByItem(bills);
  if (!totals.size) return;
  const operations = [...totals.entries()].map(([itemId, qty]) => ({
    updateOne: {
      filter: { _id: itemId },
      update: {
        $inc: {
          stockQty: Math.round(sign * qty * 10000) / 10000,
          soldQty: Math.round(-sign * qty * 10000) / 10000,
        },
      },
    },
  }));
  try {
    await StockItem.bulkWrite(operations, { ordered: false });
  } catch (error) {
    // The bill is already saved; a stock miss is logged, never lost silently.
    logger.error("Stock update for bills failed", { error: error.message, items: totals.size });
  }
};

module.exports = { moveStockForBills };
