const {
  saveImageFiles,
  deleteImageFiles,
} = require("../services/productWorkflowService");
const logger = require("../utils/logger");

/* ── ERP image upload ─────────────────────────────────────────────────────
 * Deliberately reuses the website's existing pipeline (multer memory storage
 * → sharp resize/optimise → Cloudinary) rather than adding a second one, so a
 * photo uploaded from the counter is processed identically to one uploaded
 * from the website admin and lands in the same Cloudinary folder.
 * ──────────────────────────────────────────────────────────────────────── */

const uploadErpImages = async (req, res) => {
  try {
    const files = req.files || (req.file ? [req.file] : []);

    if (!files.length) {
      return res.status(400).json({ message: "Choose at least one image." });
    }

    const urls = await saveImageFiles(files);

    if (!urls.length) {
      return res.status(500).json({
        message:
          "The image could not be saved. Check the Cloudinary settings on the server.",
      });
    }

    logger.info("ERP image upload", {
      count: urls.length,
      by: req.user?.name || "",
    });

    return res.status(201).json({ urls, url: urls[0] });
  } catch (error) {
    logger.error("ERP image upload failed", { error: error.message });
    return res.status(500).json({
      message: error.message || "Could not upload the image.",
      error: error.message,
    });
  }
};

/**
 * Remove an image from Cloudinary.
 * Only called when a product edit replaces or clears a photo — never on
 * product delete, because ERP delete archives rather than removes and the
 * image may still be referenced by an old order or bill.
 */
const deleteErpImage = async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ message: "url is required" });

    await deleteImageFiles([url]);
    return res.json({ ok: true });
  } catch (error) {
    logger.error("ERP image delete failed", { error: error.message });
    return res
      .status(500)
      .json({ message: "Could not remove the image", error: error.message });
  }
};

module.exports = { uploadErpImages, deleteErpImage };
