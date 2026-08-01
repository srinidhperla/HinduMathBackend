const Order = require("../models/Order");
const { emitAdminDataUpdated } = require("../services/orderEvents");
const logger = require("../utils/logger");

/* ── Website orders, as the shop counter needs them ───────────────────────
 * The customer website already writes Orders and already broadcasts changes
 * over Socket.IO, so the ERP is a second consumer of that same feed — no new
 * infrastructure. These endpoints are role-gated for ERP staff (a cashier is
 * not an `admin`, so the existing /api/orders admin routes don't fit).
 * ──────────────────────────────────────────────────────────────────────── */

// Statuses the counter is allowed to set, and what may follow what.
const ALLOWED_TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

const toErpOrder = (order) => ({
  id: String(order._id),
  orderCode: order.orderCode || "",
  status: order.status,
  paymentStatus: order.paymentStatus,
  paymentMethod: order.paymentMethod,
  source: order.source || "website",
  customerName: order.user?.name || "",
  customerPhone: order.deliveryAddress?.phone || order.user?.phone || "",
  address: order.deliveryAddress?.formattedAddress || order.deliveryAddress?.street || "",
  deliveryDate: order.deliveryDate,
  deliveryTime: order.deliveryTime || "",
  deliveryMode: order.deliveryMode,
  specialInstructions: order.specialInstructions || "",
  subtotal: Number(order.subtotal || 0),
  deliveryFee: Number(order.deliveryFee || 0),
  discountAmount: Number(order.discountAmount || 0),
  couponCode: order.couponCode || "",
  totalAmount: Number(order.totalAmount || 0),
  linkedBillId: order.linkedBillId || null,
  createdAt: order.createdAt,
  items: (order.items || []).map((item) => ({
    productId: item.product?._id ? String(item.product._id) : String(item.product || ""),
    name: item.productName || item.product?.name || "",
    qty: Number(item.quantity || 0),
    price: Number(item.price || 0),
    weight: item.weight || item.size || "",
    flavor: item.flavor || "",
    cakeType: item.cakeType || "",
    customMessage: item.customMessage || "",
    optionSummary: item.optionSummary || "",
  })),
});

const listErpOrders = async (req, res) => {
  try {
    const { status, limit = 100 } = req.query;
    const query = {};
    if (status) query.status = status;

    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(300, Number(limit) || 100))
      .populate("items.product", "name")
      .populate("user", "name email phone")
      .lean();

    return res.json({ orders: orders.map(toErpOrder) });
  } catch (error) {
    logger.error("ERP order list failed", { error: error.message });
    return res
      .status(500)
      .json({ message: "Error loading online orders", error: error.message });
  }
};

const updateErpOrderStatus = async (req, res) => {
  try {
    const { status, message } = req.body || {};
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const allowed = ALLOWED_TRANSITIONS[order.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        message: `Cannot go from "${order.status}" to "${status}".`,
        allowed,
      });
    }

    order.status = status;
    order.statusTimeline = [
      ...(order.statusTimeline || []),
      { status, updatedAt: new Date(), actorRole: "admin" },
    ];
    if (status === "cancelled" && message) order.rejectionMessage = String(message);
    if (status === "confirmed" && message) order.acceptanceMessage = String(message);

    await order.save();

    emitAdminDataUpdated("orders", {
      action: "status-updated",
      orderId: String(order._id),
      status,
      source: "erp",
    });

    const populated = await Order.findById(order._id)
      .populate("items.product", "name")
      .populate("user", "name email phone")
      .lean();

    return res.json(toErpOrder(populated));
  } catch (error) {
    logger.error("ERP order status update failed", { error: error.message });
    return res
      .status(500)
      .json({ message: "Error updating order", error: error.message });
  }
};

/** Records which ERP bill an order was billed as, so it can't be billed twice. */
const linkErpOrderBill = async (req, res) => {
  try {
    const { billId, billNo } = req.body || {};
    if (!billId) return res.status(400).json({ message: "billId is required" });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (order.linkedBillId) {
      return res.status(409).json({
        message: `This order was already billed (${order.linkedBillNo || order.linkedBillId}).`,
      });
    }

    order.linkedBillId = String(billId);
    order.linkedBillNo = String(billNo || "");
    await order.save();

    return res.json({ ok: true, linkedBillId: order.linkedBillId });
  } catch (error) {
    logger.error("ERP order bill link failed", { error: error.message });
    return res
      .status(500)
      .json({ message: "Error linking bill", error: error.message });
  }
};

module.exports = { listErpOrders, updateErpOrderStatus, linkErpOrderBill };
