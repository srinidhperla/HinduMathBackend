const Order = require("../models/Order");
const User = require("../models/User");

const toSafeSortDirection = (value) =>
  String(value || "").toLowerCase() === "asc" ? 1 : -1;

const buildDeliveryOrdersQuery = (deliveryPartnerId, statusFilter = []) => {
  const baseQuery = {
    assignedDeliveryPartner: deliveryPartnerId,
    deliveryStatus: { $ne: "delivered" },
  };

  if (Array.isArray(statusFilter) && statusFilter.length > 0) {
    baseQuery.status = { $in: statusFilter };
  } else {
    baseQuery.status = { $in: ["confirmed", "preparing", "ready"] };
  }

  return baseQuery;
};

const getDeliveryPartners = async (req, res) => {
  try {
    const deliveryPartners = await User.find({ role: "delivery" })
      .select("_id name email phone")
      .sort({ name: 1 })
      .lean();

    return res.json(deliveryPartners);
  } catch (error) {
    return res.status(500).json({
      message: "Error fetching delivery partners",
      error: error.message,
    });
  }
};

const getDeliveryPartnerOrders = async (req, res) => {
  try {
    const deliveryPartnerId = req.user._id;
    const statusFilter = String(req.query.status || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const sortDirection = toSafeSortDirection(req.query.sortOrder);

    const orders = await Order.find(
      buildDeliveryOrdersQuery(deliveryPartnerId, statusFilter),
    )
      .populate("items.product", "name")
      .populate("user", "name phone email")
      .populate("assignedDeliveryPartner", "name phone")
      .sort({ createdAt: sortDirection });

    return res.json(orders);
  } catch (error) {
    return res.status(500).json({
      message: "Error fetching delivery orders",
      error: error.message,
    });
  }
};

module.exports = {
  getDeliveryPartners,
  getDeliveryPartnerOrders,
};

