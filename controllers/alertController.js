const Order = require("../models/Order");

exports.getAlertOrders = async (req, res) => {
  try {
    const { status, limit } = req.query;
    const query = {};

    if (status) {
      query.status = status;
    }

    const parsedLimit = Number(limit);
    const resolvedLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 200)
        : 200;

    const orders = await Order.find(query)
      .populate("items.product", "name")
      .populate("user", "name phone")
      .sort({ createdAt: -1 })
      .limit(resolvedLimit)
      .lean();

    return res.json({
      count: orders.length,
      orders,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Error fetching alert orders",
      error: error.message,
    });
  }
};
