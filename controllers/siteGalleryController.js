const imageStorage = require("../services/cloudinaryStorage");
const { processUploadedImage } = require("../services/imageProcessing");
const { emitAdminDataUpdated } = require("../services/orderEvents");
const {
  buildGalleryFieldConfigPayload,
  buildGalleryItemPayload,
  formatGalleryItemResponse,
  getGalleryFieldConfig,
  normalizeGalleryFieldMutations,
  syncGalleryItemsWithFieldConfig,
} = require("../services/galleryAdminService");
const {
  getOrCreateSiteContent,
  invalidatePublicCache,
} = require("../services/siteContentService");

const uploadGalleryImage = async (file) => {
  const processedImage = await processUploadedImage(file);
  const fileName = `gallery-${Date.now()}-${processedImage.fileName}`;
  const result = await imageStorage.uploadFile(
    processedImage.buffer,
    fileName,
    processedImage.mimeType,
  );

  return result.url;
};

exports.addGalleryItem = async (req, res) => {
  try {
    const content = await getOrCreateSiteContent();
    const currentFieldConfig = getGalleryFieldConfig(content);
    const nextFieldConfig = buildGalleryFieldConfigPayload(
      req.body.galleryFieldConfig,
      currentFieldConfig,
    );
    const fieldMutations = normalizeGalleryFieldMutations(
      req.body.galleryFieldMutations,
    );

    content.galleryFieldConfig = nextFieldConfig;
    syncGalleryItemsWithFieldConfig(
      content.galleryItems,
      nextFieldConfig,
      fieldMutations,
    );

    const galleryItemPayload = buildGalleryItemPayload(
      req.body,
      null,
      nextFieldConfig,
    );

    if (req.file) {
      galleryItemPayload.imageUrl = await uploadGalleryImage(req.file);
    } else {
      galleryItemPayload.imageUrl = String(req.body.imageUrl || "").trim();
    }

    content.galleryItems.unshift(galleryItemPayload);

    await content.save();
    await invalidatePublicCache({ action: "addGalleryItem" });
    emitAdminDataUpdated("settings", { action: "gallery-item-added" });

    return res.status(201).json({
      ...content.toObject(),
      galleryItems: content.galleryItems.map((item) => formatGalleryItemResponse(item)),
    });
  } catch (error) {
    return res.status(500).json({
      message: "Error adding gallery item",
      error: error.message,
    });
  }
};

exports.updateGalleryItem = async (req, res) => {
  try {
    const content = await getOrCreateSiteContent();
    const galleryItem = content.galleryItems.id(req.params.itemId);

    if (!galleryItem) {
      return res.status(404).json({ message: "Gallery item not found" });
    }

    const currentFieldConfig = getGalleryFieldConfig(content);
    const nextFieldConfig = buildGalleryFieldConfigPayload(
      req.body.galleryFieldConfig,
      currentFieldConfig,
    );
    const fieldMutations = normalizeGalleryFieldMutations(
      req.body.galleryFieldMutations,
    );

    content.galleryFieldConfig = nextFieldConfig;
    syncGalleryItemsWithFieldConfig(
      content.galleryItems,
      nextFieldConfig,
      fieldMutations,
    );

    Object.assign(
      galleryItem,
      buildGalleryItemPayload(req.body, galleryItem, nextFieldConfig),
    );

    if (req.file) {
      const previousFileId = imageStorage.extractFileId(galleryItem.imageUrl);
      galleryItem.imageUrl = await uploadGalleryImage(req.file);

      if (previousFileId) {
        await imageStorage.deleteFile(previousFileId).catch(() => null);
      }
    } else if (req.body.imageUrl) {
      galleryItem.imageUrl = String(req.body.imageUrl).trim();
    }

    await content.save();
    await invalidatePublicCache({ action: "updateGalleryItem" });
    emitAdminDataUpdated("settings", { action: "gallery-item-updated" });

    return res.json({
      ...content.toObject(),
      galleryItems: content.galleryItems.map((item) => formatGalleryItemResponse(item)),
    });
  } catch (error) {
    return res.status(500).json({
      message: "Error updating gallery item",
      error: error.message,
    });
  }
};

exports.deleteGalleryItem = async (req, res) => {
  try {
    const content = await getOrCreateSiteContent();
    const galleryItem = content.galleryItems.id(req.params.itemId);

    if (!galleryItem) {
      return res.status(404).json({ message: "Gallery item not found" });
    }

    const fileId = imageStorage.extractFileId(galleryItem.imageUrl);
    if (fileId) {
      await imageStorage.deleteFile(fileId);
    }

    galleryItem.deleteOne();
    await content.save();
    await invalidatePublicCache({ action: "deleteGalleryItem" });
    emitAdminDataUpdated("settings", { action: "gallery-item-deleted" });

    return res.json({
      message: "Gallery item deleted successfully",
      id: req.params.itemId,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Error deleting gallery item",
      error: error.message,
    });
  }
};
