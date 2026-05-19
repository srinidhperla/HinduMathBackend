const SiteContent = require("../models/SiteContent");
const { SITE_KEY } = require("../config/constants");
const { clearPublicApiCache } = require("./cacheStore");
const {
  getGalleryFieldConfig,
  syncGalleryItemsWithFieldConfig,
} = require("./galleryAdminService");
const logger = require("../utils/logger");

const getOrCreateSiteContent = async () => {
  let content = await SiteContent.findOne({ singletonKey: SITE_KEY });

  if (!content) {
    content = await SiteContent.create({ singletonKey: SITE_KEY });
  }

  const galleryFieldConfig = getGalleryFieldConfig(content);
  const hasMissingFieldConfig =
    !content.galleryFieldConfig ||
    !Array.isArray(content.galleryFieldConfig.fieldSections) ||
    !Array.isArray(content.galleryFieldConfig.optionCatalogs);

  if (hasMissingFieldConfig) {
    content.galleryFieldConfig = galleryFieldConfig;
    syncGalleryItemsWithFieldConfig(content.galleryItems, galleryFieldConfig);
    await content.save();
  }

  return content;
};

const invalidatePublicCache = async (context = {}) => {
  try {
    await clearPublicApiCache();
  } catch (error) {
    logger.warn("Failed to clear public API cache after site mutation", {
      error: error?.message || String(error),
      ...context,
    });
  }
};

module.exports = {
  getOrCreateSiteContent,
  invalidatePublicCache,
};
