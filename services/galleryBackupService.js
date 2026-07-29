const { ZipArchive } = require("archiver");
const AdmZip = require("adm-zip");
const imageStorage = require("./cloudinaryStorage");
const logger = require("../utils/logger");
const {
  MANIFEST_NAME,
  buildManifest,
  createCategorySequencer,
  downloadImage,
  isImageAlive,
  isManifestEntry,
  resolveExtension,
  slugify,
} = require("./backupShared");

// Trailing 24-hex id immediately before the file extension.
const OBJECT_ID_PATTERN = /([0-9a-fA-F]{24})(?=\.[a-zA-Z0-9]+$)/;

const buildBackupFileName = ({ item, nextSequence, extension }) => {
  const categorySlug = slugify(item?.category, "cake");
  const sequence = nextSequence(categorySlug);
  const titleSlug = slugify(item?.title, "cake");

  return `${categorySlug}/${sequence}__${titleSlug}__${item._id}.${extension}`;
};

const streamGalleryBackupZip = async (res, galleryItems = []) => {
  const archive = new ZipArchive({ zlib: { level: 9 } });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="gallery-backup-${Date.now()}.zip"`,
  );

  archive.on("error", (error) => {
    logger.error(`Gallery backup archive error: ${error.message}`);
    res.destroy(error);
  });

  archive.pipe(res);

  const nextSequence = createCategorySequencer();
  const included = [];
  const failed = [];

  for (const item of galleryItems) {
    const describe = {
      id: String(item?._id),
      title: item?.title,
      category: item?.category,
    };

    if (!item?.imageUrl) {
      failed.push({ ...describe, reason: "Item has no image URL" });
      continue;
    }

    try {
      const { buffer, contentType } = await downloadImage(item.imageUrl);
      const fileName = buildBackupFileName({
        item,
        nextSequence,
        extension: resolveExtension(item.imageUrl, contentType),
      });

      archive.append(buffer, { name: fileName });
      included.push({ ...describe, fileName, bytes: buffer.length });
    } catch (error) {
      logger.error(
        `Gallery backup: image failed for ${item._id}: ${error.message}`,
      );
      failed.push({ ...describe, reason: error.message, imageUrl: item.imageUrl });
    }
  }

  // A backup that silently drops images is worse than no backup, so record
  // exactly what made it in and what did not.
  const manifest = buildManifest({
    kind: "gallery",
    totalItems: galleryItems.length,
    included,
    failed,
  });

  archive.append(Buffer.from(JSON.stringify(manifest, null, 2)), {
    name: MANIFEST_NAME,
  });

  if (failed.length > 0) {
    logger.warn(
      `Gallery backup completed with ${failed.length} missing image(s) out of ${galleryItems.length}`,
    );
  }

  await archive.finalize();

  return manifest;
};

/**
 * @param {"missing"|"all"} mode  "missing" (default) only re-uploads images
 *   whose current URL is dead, so intact images cost no Cloudinary usage and
 *   are never needlessly replaced. "all" force-replaces every matched image.
 */
const restoreGalleryImagesFromZip = async (zipBuffer, content, { mode = "missing" } = {}) => {
  const entries = new AdmZip(zipBuffer)
    .getEntries()
    .filter((entry) => !entry.isDirectory && !isManifestEntry(entry.entryName));

  const updated = [];
  const skipped = [];
  const alreadyHealthy = [];

  for (const entry of entries) {
    const itemId = entry.entryName.match(OBJECT_ID_PATTERN)?.[1];

    if (!itemId) {
      skipped.push({
        fileName: entry.entryName,
        reason: "No cake ID found in file name",
      });
      continue;
    }

    const galleryItem = content.galleryItems.id(itemId);

    if (!galleryItem) {
      skipped.push({
        fileName: entry.entryName,
        reason: "No gallery item matches this ID anymore",
      });
      continue;
    }

    try {
      if (mode === "missing" && (await isImageAlive(galleryItem.imageUrl))) {
        alreadyHealthy.push({
          id: String(galleryItem._id),
          title: galleryItem.title,
        });
        continue;
      }

      const previousFileId = imageStorage.extractFileId(galleryItem.imageUrl);
      const uploadResult = await imageStorage.uploadFile(
        entry.getData(),
        `gallery-${Date.now()}-${galleryItem._id}`,
        "image",
      );

      galleryItem.imageUrl = uploadResult.url;
      updated.push({ id: String(galleryItem._id), title: galleryItem.title });

      if (previousFileId) {
        await imageStorage.deleteFile(previousFileId).catch(() => null);
      }
    } catch (error) {
      logger.error(
        `Gallery restore: failed to upload ${entry.entryName}: ${error.message}`,
      );
      skipped.push({ fileName: entry.entryName, reason: error.message });
    }
  }

  return { updated, skipped, alreadyHealthy };
};

module.exports = {
  streamGalleryBackupZip,
  restoreGalleryImagesFromZip,
};
