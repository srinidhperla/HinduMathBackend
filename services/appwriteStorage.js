/**
 * Simple Image Storage Service
 * Stores images as base64 data URLs (no external dependencies)
 */
const logger = require("../utils/logger");

/**
 * Convert buffer to base64 data URL
 */
const uploadFile = async (buffer, fileName, mimeType) => {
  try {
    const base64 = buffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;
    logger.info(
      `Image converted to base64: ${fileName} (${Math.round(buffer.length / 1024)}KB)`,
    );
    return { fileId: fileName, url: dataUrl };
  } catch (error) {
    logger.error(`Failed to convert image: ${error.message}`);
    throw error;
  }
};

/**
 * Delete is a no-op for base64 storage (images are stored inline)
 */
const deleteFile = async (fileId) => {
  // No-op for base64 storage
  logger.info(`Delete called for: ${fileId} (no-op for base64 storage)`);
};

/**
 * Extract fileId from URL (for compatibility)
 */
const extractFileId = (url) => {
  if (!url) return null;
  // For base64 URLs, return a hash or the URL itself
  if (url.startsWith("data:")) {
    return url.substring(0, 50); // Return truncated identifier
  }
  return url;
};

/**
 * Check if configured (always true for base64)
 */
const isConfigured = () => true;

module.exports = { isConfigured, uploadFile, deleteFile, extractFileId };
