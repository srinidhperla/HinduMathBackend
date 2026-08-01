const {
  readState,
  writeState,
} = require("../services/erpStateService");
const {
  invalidatePublicCache,
} = require("../services/productWorkflowService");
const {
  emitSiteDataUpdated,
  emitAdminDataUpdated,
} = require("../services/orderEvents");
const { AuditLog, stateFieldToModel } = require("../models/erpModels");
const logger = require("../utils/logger");

/* ── Activity history ─────────────────────────────────────────────────────
 * The ERP saves whole state, so we diff the collections before and after and
 * log what actually changed. That gives a readable trail ("added 1 sale,
 * removed 1 held bill") without logging a 200 KB blob on every keystroke.
 * Auditing must never break a save — every failure here is swallowed. */
const AUDITED_FIELDS = [...Object.keys(stateFieldToModel), "products", "categories"];

async function recordStateAudit(req, before, after) {
  try {
    const changes = [];

    AUDITED_FIELDS.forEach((field) => {
      const beforeById = new Map((before?.[field] || []).map((entry) => [entry.id, entry]));
      const afterById = new Map((after?.[field] || []).map((entry) => [entry.id, entry]));

      const added = [...afterById.keys()].filter((id) => !beforeById.has(id));
      const removed = [...beforeById.keys()].filter((id) => !afterById.has(id));

      /* Edits IN PLACE matter most — a price change or a visibility toggle
       * adds and removes nothing, so counting only add/remove would leave the
       * audit trail silent on exactly the changes worth tracing. */
      const edited = [...afterById.keys()].filter((id) => {
        const previous = beforeById.get(id);
        if (!previous) return false;
        // `updatedAt` moves on every save, so ignore it when comparing.
        const strip = ({ updatedAt, ...rest }) => JSON.stringify(rest, Object.keys(rest).sort());
        return strip(previous) !== strip(afterById.get(id));
      });

      if (added.length) changes.push(`+${added.length} ${field}`);
      if (removed.length) changes.push(`-${removed.length} ${field}`);
      if (edited.length) changes.push(`~${edited.length} ${field} edited`);
    });

    // Genuinely a no-op save (a page loading and re-saving identical state).
    if (!changes.length) return;

    await AuditLog.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      actorId: String(req.user?._id || ""),
      actorName: req.user?.name || "",
      action: "state.write",
      entity: "ErpState",
      entityId: "main",
      summary: changes.join(", "),
    });
  } catch (error) {
    logger.warn("ERP audit write skipped", { error: error.message });
  }
}

const getErpState = async (req, res) => {
  try {
    const { state, rev } = await readState();
    return res.json({ state, rev });
  } catch (error) {
    logger.error("Failed to read ERP state", { error: error.message });
    return res.status(500).json({
      message: "Error loading ERP data",
      error: error.message,
    });
  }
};

const putErpState = async (req, res) => {
  const { state, rev } = req.body || {};

  if (!state || typeof state !== "object") {
    return res.status(400).json({ message: "state is required" });
  }

  if (!Number.isFinite(Number(rev))) {
    return res.status(400).json({ message: "rev is required" });
  }

  try {
    const before = await readState();
    const result = await writeState(state, Number(rev));
    await recordStateAudit(req, before.state, result.state);

    // The website caches the public product list; ERP price/visibility edits
    // must show up on the storefront without a redeploy.
    await invalidatePublicCache({ action: "erpStateWrite" });
    emitSiteDataUpdated("products", { source: "erp" });
    emitAdminDataUpdated("inventory", { source: "erp" });

    return res.json(result);
  } catch (error) {
    if (error.code === "ERP_REV_CONFLICT") {
      return res.status(409).json({
        message:
          "This data was changed on another counter. Refreshing and retrying.",
        currentRev: error.currentRev,
      });
    }

    logger.error("Failed to write ERP state", { error: error.message });
    return res.status(500).json({
      message: "Error saving ERP data",
      error: error.message,
    });
  }
};

module.exports = { getErpState, putErpState };
