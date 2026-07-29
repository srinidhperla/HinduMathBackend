const { ZipArchive } = require("archiver");
const AdmZip = require("adm-zip");
const Product = require("../models/Product");
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

// A product owns several images, so the file name carries the product id plus
// the slot that image belongs to, e.g. ...__69db6917__img0.jpg
const PRODUCT_SLOT_PATTERN = /([0-9a-fA-F]{24})__([a-z]+[0-9]*)\.[a-zA-Z0-9]+$/;

const MAIN_SLOT = "main";

/**
 * Lists every image a product owns as { slot, url } pairs.
 *
 * `image` is only emitted separately when it differs from images[0]; in the
 * common case they are the same file and backing it up twice would be waste.
 */
const collectProductImageSlots = (product = {}) => {
  const images = Array.isArray(product.images) ? product.images : [];
  const slots = images
    .map((url, index) => ({ slot: `img${index}`, url }))
    .filter((entry) => entry.url);

  if (product.image && product.image !== images[0]) {
    slots.unshift({ slot: MAIN_SLOT, url: product.image });
  }

  const addOns = Array.isArray(product.addOns) ? product.addOns : [];
  addOns.forEach((addOn, index) => {
    if (addOn?.image) {
      slots.push({ slot: `addon${index}`, url: addOn.image });
    }
  });

  return slots;
};

const streamProductBackupZip = async (res, products = []) => {
  const archive = new ZipArchive({ zlib: { level: 9 } });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="products-backup-${Date.now()}.zip"`,
  );

  archive.on("error", (error) => {
    logger.error(`Product backup archive error: ${error.message}`);
    res.destroy(error);
  });

  archive.pipe(res);

  const nextSequence = createCategorySequencer();
  const included = [];
  const failed = [];

  for (const product of products) {
    const categorySlug = slugify(product?.category, "product");
    const sequence = nextSequence(categorySlug);
    const nameSlug = slugify(product?.name, "product");
    const describe = {
      id: String(product?._id),
      name: product?.name,
      category: product?.category,
    };

    const imageSlots = collectProductImageSlots(product);

    if (imageSlots.length === 0) {
      failed.push({ ...describe, reason: "Product has no images" });
      continue;
    }

    for (const { slot, url } of imageSlots) {
      try {
        const { buffer, contentType } = await downloadImage(url);
        const extension = resolveExtension(url, contentType);
        const fileName = `${categorySlug}/${sequence}__${nameSlug}__${product._id}__${slot}.${extension}`;

        archive.append(buffer, { name: fileName });
        included.push({ ...describe, slot, fileName, bytes: buffer.length });
      } catch (error) {
        logger.error(
          `Product backup: ${slot} failed for ${product._id}: ${error.message}`,
        );
        failed.push({
          ...describe,
          slot,
          reason: error.message,
          imageUrl: String(url).startsWith("data:") ? "(inline base64 image)" : url,
        });
      }
    }
  }

  const manifest = buildManifest({
    kind: "products",
    totalItems: products.length,
    included,
    failed,
  });

  archive.append(Buffer.from(JSON.stringify(manifest, null, 2)), {
    name: MANIFEST_NAME,
  });

  if (failed.length > 0) {
    logger.warn(
      `Product backup completed with ${failed.length} missing image(s)`,
    );
  }

  await archive.finalize();

  return manifest;
};

/** Reads the URL currently stored in a given product image slot. */
const readSlotUrl = (product, slot) => {
  if (slot === MAIN_SLOT) {
    return product.image;
  }
  if (slot.startsWith("img")) {
    return product.images?.[Number(slot.slice(3))];
  }
  if (slot.startsWith("addon")) {
    return product.addOns?.[Number(slot.slice(5))]?.image;
  }
  return "";
};

/**
 * @param {"missing"|"all"} mode  "missing" (default) only re-uploads slots whose
 *   current image is dead, so intact images cost no Cloudinary usage and are
 *   never needlessly replaced. "all" force-replaces every matched image.
 */
const restoreProductImagesFromZip = async (zipBuffer, { mode = "missing" } = {}) => {
  const entries = new AdmZip(zipBuffer)
    .getEntries()
    .filter((entry) => !entry.isDirectory && !isManifestEntry(entry.entryName));

  const updated = [];
  const skipped = [];
  const alreadyHealthy = [];

  // Group by product so each document is loaded and saved exactly once.
  const entriesByProductId = new Map();

  for (const entry of entries) {
    const match = entry.entryName.match(PRODUCT_SLOT_PATTERN);

    if (!match) {
      skipped.push({
        fileName: entry.entryName,
        reason: "No product ID and slot found in file name",
      });
      continue;
    }

    const [, productId, slot] = match;
    if (!entriesByProductId.has(productId)) {
      entriesByProductId.set(productId, []);
    }
    entriesByProductId.get(productId).push({ entry, slot });
  }

  for (const [productId, slotEntries] of entriesByProductId) {
    const product = await Product.findById(productId).catch(() => null);

    if (!product) {
      slotEntries.forEach(({ entry }) =>
        skipped.push({
          fileName: entry.entryName,
          reason: "No product matches this ID anymore",
        }),
      );
      continue;
    }

    // Captured before mutating so the main/images[0] link can be preserved.
    const mainMirroredFirstImage = product.image === product.images?.[0];
    const staleFileIds = [];
    let changedSlots = 0;

    for (const { entry, slot } of slotEntries) {
      try {
        if (mode === "missing" && (await isImageAlive(readSlotUrl(product, slot)))) {
          alreadyHealthy.push({ id: productId, name: product.name, slot });
          continue;
        }

        const uploadResult = await imageStorage.uploadFile(
          entry.getData(),
          `product-${Date.now()}-${productId}-${slot}`,
          "image",
        );

        if (slot === MAIN_SLOT) {
          staleFileIds.push(imageStorage.extractFileId(product.image));
          product.image = uploadResult.url;
        } else if (slot.startsWith("img")) {
          const index = Number(slot.slice(3));
          if (!Array.isArray(product.images)) {
            product.images = [];
          }
          staleFileIds.push(imageStorage.extractFileId(product.images[index]));
          product.images[index] = uploadResult.url;
        } else if (slot.startsWith("addon")) {
          const index = Number(slot.slice(5));
          if (!product.addOns?.[index]) {
            skipped.push({
              fileName: entry.entryName,
              reason: `Product no longer has add-on #${index}`,
            });
            continue;
          }
          staleFileIds.push(imageStorage.extractFileId(product.addOns[index].image));
          product.addOns[index].image = uploadResult.url;
        } else {
          skipped.push({
            fileName: entry.entryName,
            reason: `Unrecognised image slot "${slot}"`,
          });
          continue;
        }

        changedSlots += 1;
        updated.push({ id: productId, name: product.name, slot });
      } catch (error) {
        logger.error(
          `Product restore: failed to upload ${entry.entryName}: ${error.message}`,
        );
        skipped.push({ fileName: entry.entryName, reason: error.message });
      }
    }

    if (changedSlots === 0) {
      continue;
    }

    // Keep the primary image pointing at the first gallery image when it did
    // before, otherwise the card thumbnail would still show the old URL.
    if (mainMirroredFirstImage && product.images?.[0]) {
      product.image = product.images[0];
    }

    product.markModified("images");
    product.markModified("addOns");
    await product.save();

    await Promise.all(
      staleFileIds
        .filter(Boolean)
        .map((fileId) => imageStorage.deleteFile(fileId).catch(() => null)),
    );
  }

  return { updated, skipped, alreadyHealthy };
};

module.exports = {
  collectProductImageSlots,
  streamProductBackupZip,
  restoreProductImagesFromZip,
};
