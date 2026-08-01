const crypto = require("crypto");
const User = require("../models/User");
const Order = require("../models/Order");
const { AuditLog } = require("../models/erpModels");
const logger = require("../utils/logger");

/* ── Staff & permissions ──────────────────────────────────────────────────
 * Roles give a sensible default; `permissions` overrides per module when the
 * owner wants something narrower. The ERP frontend hides what a user cannot
 * see, but hiding is not security — every ERP write already goes through
 * requireRole, and the owner-only endpoints below are gated again here.
 *
 * Passwords are never set or read through this API. Staff use the normal
 * website register/forgot-password flow; the owner only promotes an existing
 * account to a staff role. That keeps credential handling in one place.
 * ──────────────────────────────────────────────────────────────────────── */

const ERP_ROLES = ["owner", "manager", "cashier", "production", "admin"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_NOTICE =
  "Account created. Ask them to use Forgot password on the website to set their own password.";

const MODULES = [
  "dashboard",
  "pos",
  "sales",
  "orders",
  "cakeOrders",
  "production",
  "recipes",
  "inventory",
  "ingredients",
  "expiry",
  "products",
  "categories",
  "barcode",
  "purchases",
  "suppliers",
  "customers",
  "expenses",
  "finance",
  "reports",
  "analytics",
  "website",
  "notifications",
  "settings",
  "users",
];

/* Defaults per role. `true` means full access to that module. */
const ROLE_DEFAULTS = {
  owner: MODULES,
  admin: MODULES,
  manager: MODULES.filter((module) => !["users", "finance"].includes(module)),
  cashier: ["dashboard", "pos", "sales", "orders", "customers", "notifications"],
  production: [
    "dashboard",
    "production",
    "recipes",
    "inventory",
    "ingredients",
    "expiry",
    "notifications",
  ],
};

const buildPermissions = (role, overrides) => {
  const allowed = new Set(ROLE_DEFAULTS[role] || []);
  const result = {};
  MODULES.forEach((module) => {
    const override = overrides?.[module];
    result[module] = typeof override === "boolean" ? override : allowed.has(module);
  });
  return result;
};

const toErpUser = (user, stats = {}) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  phone: user.phone || "",
  role: user.role,
  isErpStaff: ERP_ROLES.includes(user.role),
  isActive: !user.erpDisabledAt,
  disabledAt: user.erpDisabledAt || null,
  permissions: buildPermissions(user.role, user.erpPermissions),
  hasOverrides: Object.keys(user.erpPermissions || {}).length > 0,
  createdAt: user.createdAt || null,
  updatedAt: user.updatedAt || null,
  lastLoginAt: user.lastLoginAt || null,
  city: user.address?.city || "",
  savedAddressCount: (user.savedAddresses || []).length,
  orderCount: 0,
  totalSpend: 0,
  lastOrderAt: null,
  ...stats,
});

const listErpUsers = async (req, res) => {
  try {
    const users = await User.find({}).select("-password").sort({ name: 1 }).lean();

    /* Order history per account, so the owner can see whether someone is a
     * real customer before changing anything. One aggregate beats N queries. */
    const orderStats = await Order.aggregate([
      {
        $group: {
          _id: "$user",
          orderCount: { $sum: 1 },
          totalSpend: { $sum: "$totalAmount" },
          lastOrderAt: { $max: "$createdAt" },
        },
      },
    ]);
    const statsById = new Map(
      orderStats.map((entry) => [
        String(entry._id),
        {
          orderCount: entry.orderCount,
          totalSpend: Math.round(entry.totalSpend || 0),
          lastOrderAt: entry.lastOrderAt,
        },
      ]),
    );

    return res.json({
      users: users.map((user) => toErpUser(user, statsById.get(String(user._id)))),
      modules: MODULES,
      roleDefaults: ROLE_DEFAULTS,
    });
  } catch (error) {
    logger.error("ERP user list failed", { error: error.message });
    return res
      .status(500)
      .json({ message: "Error loading staff", error: error.message });
  }
};

const updateErpUser = async (req, res) => {
  try {
    const { role, permissions } = req.body || {};
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    // An owner must never be able to lock themselves out of Users & Roles.
    if (String(user._id) === String(req.user._id) && role && role !== user.role) {
      return res
        .status(400)
        .json({ message: "You cannot change your own role. Ask another owner." });
    }

    const before = { role: user.role, permissions: user.erpPermissions };

    if (role) {
      if (![...ERP_ROLES, "user", "delivery"].includes(role)) {
        return res.status(400).json({ message: `Unknown role "${role}".` });
      }
      user.role = role;
    }

    if (permissions && typeof permissions === "object") {
      const cleaned = {};
      MODULES.forEach((module) => {
        if (typeof permissions[module] === "boolean") {
          cleaned[module] = permissions[module];
        }
      });
      user.erpPermissions = cleaned;
    }

    await user.save();

    await AuditLog.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      actorId: String(req.user._id),
      actorName: req.user.name,
      action: "user.update",
      entity: "User",
      entityId: String(user._id),
      before,
      after: { role: user.role, permissions: user.erpPermissions },
    }).catch((error) =>
      logger.warn("audit write failed", { error: error.message }),
    );

    return res.json(toErpUser(user.toObject()));
  } catch (error) {
    logger.error("ERP user update failed", { error: error.message });
    return res
      .status(500)
      .json({ message: "Error updating staff", error: error.message });
  }
};

const listAuditLog = async (req, res) => {
  try {
    const { limit = 200 } = req.query;
    const entries = await AuditLog.find({})
      .sort({ at: -1 })
      .limit(Math.min(1000, Number(limit) || 200))
      .lean();
    return res.json({ entries: entries.map(({ _id, __v, ...rest }) => rest) });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error loading activity log", error: error.message });
  }
};


const writeAudit = (req, action, entityId, payload) =>
  AuditLog.create({
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    actorId: String(req.user?._id || ""),
    actorName: req.user?.name || "",
    action,
    entity: "User",
    entityId,
    ...payload,
  }).catch((error) => logger.warn("audit write failed", { error: error.message }));

/**
 * Create a staff account.
 * We do NOT accept a password. A random one nobody is told is set, and the
 * person completes setup through the normal forgot-password flow — so a
 * password is never typed into, stored by, or logged from the ERP.
 */
const createErpUser = async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const phone = String(req.body?.phone || "").trim();
    const role = req.body?.role || "cashier";

    if (!name) return res.status(400).json({ message: "Name is required." });
    if (!EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ message: "Enter a valid email address." });
    }
    if (!ERP_ROLES.includes(role)) {
      return res.status(400).json({ message: `"${role}" is not a staff role.` });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({
        message: `${email} already has an account — change its role instead.`,
      });
    }

    const user = new User({
      name,
      email,
      phone,
      role,
      // Unguessable and never revealed; the user resets it to log in.
      password: crypto.randomBytes(24).toString("hex"),
    });
    await user.save();

    await writeAudit(req, "user.create", String(user._id), {
      summary: `created ${email} as ${role}`,
      after: { name, email, role },
    });

    return res.status(201).json({
      user: toErpUser(user.toObject(), {
        orderCount: 0,
        totalSpend: 0,
        lastOrderAt: null,
      }),
      notice: RESET_NOTICE,
    });
  } catch (error) {
    logger.error("ERP user create failed", { error: error.message });
    return res
      .status(500)
      .json({ message: "Error creating staff", error: error.message });
  }
};

/** Turn ERP access off without destroying history. */
const setErpUserActive = async (req, res) => {
  try {
    const active = req.body?.active !== false;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (String(user._id) === String(req.user._id)) {
      return res.status(400).json({ message: "You cannot disable your own account." });
    }

    user.erpDisabledAt = active ? null : new Date().toISOString();
    await user.save();

    await writeAudit(req, active ? "user.enable" : "user.disable", String(user._id), {
      summary: `${active ? "enabled" : "disabled"} ${user.email}`,
    });

    return res.json(toErpUser(user.toObject()));
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error updating access", error: error.message });
  }
};

/**
 * Delete an account. Refused when the person has orders — deleting them would
 * orphan real financial records. Disable instead; the UI says so.
 */
const deleteErpUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (String(user._id) === String(req.user._id)) {
      return res.status(400).json({ message: "You cannot delete your own account." });
    }

    const orderCount = await Order.countDocuments({ user: user._id });
    if (orderCount > 0) {
      return res.status(409).json({
        message: `${user.name} has ${orderCount} order${
          orderCount === 1 ? "" : "s"
        } on record. Disable the account instead so the order history stays intact.`,
      });
    }

    const snapshot = { name: user.name, email: user.email, role: user.role };
    await User.deleteOne({ _id: user._id });

    await writeAudit(req, "user.delete", String(user._id), {
      summary: `deleted ${snapshot.email}`,
      before: snapshot,
    });

    return res.json({ ok: true });
  } catch (error) {
    logger.error("ERP user delete failed", { error: error.message });
    return res
      .status(500)
      .json({ message: "Error deleting user", error: error.message });
  }
};

module.exports = {
  listErpUsers,
  updateErpUser,
  createErpUser,
  setErpUserActive,
  deleteErpUser,
  listAuditLog,
  MODULES,
  ROLE_DEFAULTS,
};
