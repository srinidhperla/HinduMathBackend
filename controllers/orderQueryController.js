const Order = require("../models/Order");
const Product = require("../models/Product");
const User = require("../models/User");
const { subscribeToOrderEvents } = require("../services/orderEvents");
const {
  toLocalDateKey,
  getLastNDates,
} = require("../services/orderWorkflowService");

const getUserOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id })
      .populate("items.product")
      .populate("assignedDeliveryPartner", "name phone")
      .sort({ createdAt: -1 });

    return res.json(orders);
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error fetching orders", error: error.message });
  }
};

const getOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate("items.product")
      .populate("user", "name email phone")
      .populate("assignedDeliveryPartner", "name phone");

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (
      order.user._id.toString() !== req.user._id.toString() &&
      req.user.role !== "admin" &&
      !(
        req.user.role === "delivery" &&
        order.assignedDeliveryPartner?._id?.toString() === req.user._id.toString()
      )
    ) {
      return res.status(403).json({ message: "Not authorized to view this order" });
    }

    return res.json(order);
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error fetching order", error: error.message });
  }
};

const getAllOrders = async (req, res) => {
  try {
    const { status, startDate, endDate } = req.query;
    const query = {};

    if (status) {
      query.status = status;
    }
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const orders = await Order.find(query)
      .populate("items.product")
      .populate("user", "name email phone")
      .populate("assignedDeliveryPartner", "name phone")
      .sort({ createdAt: -1 });

    return res.json(orders);
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error fetching orders", error: error.message });
  }
};

const getOrderAnalytics = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const query = {};

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const orders = await Order.find(query).populate("items.product", "name category").lean();
    const [productCount, customerCount] = await Promise.all([
      Product.countDocuments({}),
      User.countDocuments({ role: "user" }),
    ]);

    const last30Days = getLastNDates(30);
    const dailyRevenueMap = new Map(last30Days.map((entry) => [entry.key, 0]));
    const ordersPerDayMap = new Map(last30Days.map((entry) => [entry.key, 0]));
    const todayKey = toLocalDateKey(new Date());
    const nonCancelledOrders = orders.filter((order) => order.status !== "cancelled");
    const totalRevenue = nonCancelledOrders.reduce(
      (sum, order) => sum + Number(order.totalAmount || 0),
      0,
    );
    const averageOrderValue = nonCancelledOrders.length
      ? totalRevenue / nonCancelledOrders.length
      : 0;

    const categoryTotals = {};
    const productSales = {};
    const statusBreakdown = {};
    let todayOrders = 0;
    let todayRevenue = 0;
    let pendingOrders = 0;

    orders.forEach((order) => {
      const createdKey = toLocalDateKey(order.createdAt || new Date());
      const isNotCancelled = order.status !== "cancelled";

      statusBreakdown[order.status] = (statusBreakdown[order.status] || 0) + 1;
      if (order.status === "pending") pendingOrders += 1;
      if (ordersPerDayMap.has(createdKey)) {
        ordersPerDayMap.set(createdKey, Number(ordersPerDayMap.get(createdKey) || 0) + 1);
      }
      if (isNotCancelled && dailyRevenueMap.has(createdKey)) {
        dailyRevenueMap.set(
          createdKey,
          Number(dailyRevenueMap.get(createdKey) || 0) + Number(order.totalAmount || 0),
        );
      }
      if (createdKey === todayKey) {
        todayOrders += 1;
        if (isNotCancelled) todayRevenue += Number(order.totalAmount || 0);
      }

      (order.items || []).forEach((item) => {
        const category = item.product?.category || "other";
        const amount = Number(item.price || 0) * Number(item.quantity || 0);
        categoryTotals[category] = (categoryTotals[category] || 0) + amount;
        const productName = item.product?.name || "Custom";
        productSales[productName] = {
          name: productName,
          quantity:
            Number(productSales[productName]?.quantity || 0) + Number(item.quantity || 0),
          revenue: Number(productSales[productName]?.revenue || 0) + amount,
        };
      });
    });

    return res.json({
      totalRevenue,
      averageOrderValue,
      orderCount: orders.length,
      productCount,
      customerCount,
      todayOrders,
      todayRevenue,
      pendingOrders,
      categoryTotals,
      statusBreakdown,
      dailyRevenue: last30Days.map((entry) => ({
        date: entry.key,
        label: entry.label,
        revenue: Number(dailyRevenueMap.get(entry.key) || 0),
      })),
      ordersPerDay: last30Days.map((entry) => ({
        date: entry.key,
        label: entry.label,
        count: Number(ordersPerDayMap.get(entry.key) || 0),
      })),
      topProducts: Object.values(productSales)
        .sort((left, right) => right.quantity - left.quantity)
        .slice(0, 5),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      message: "Error fetching order analytics",
      error: error.message,
    });
  }
};

const streamOrders = async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  const unsubscribe = subscribeToOrderEvents((event) => {
    res.write(`event: ${event.eventName}\ndata: ${JSON.stringify(event)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    res.write(
      `event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`,
    );
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
};

module.exports = {
  getUserOrders,
  getOrder,
  getAllOrders,
  getOrderAnalytics,
  streamOrders,
};

