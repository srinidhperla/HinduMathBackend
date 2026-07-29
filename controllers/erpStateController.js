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
const logger = require("../utils/logger");

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
    const result = await writeState(state, Number(rev));

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
