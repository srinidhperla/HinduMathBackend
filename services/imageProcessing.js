const sharp = require("sharp");

const TARGET_IMAGE_BYTES = 300 * 1024;
const MAX_IMAGE_BYTES = 500 * 1024;
const MAX_IMAGE_DIMENSION = 1600;
const MIN_IMAGE_DIMENSION = 700;
const DIMENSION_STEP = 200;
const WEBP_QUALITY_STEPS = [84, 80, 76, 72, 68, 64, 60, 56, 52, 48];

const sanitizeBaseName = (value = "image") =>
  String(value || "image")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-+|-+$/g, "") || `image-${Date.now()}`;

const buildResizeLimits = () => {
  const limits = [];

  for (
    let currentSize = MAX_IMAGE_DIMENSION;
    currentSize >= MIN_IMAGE_DIMENSION;
    currentSize -= DIMENSION_STEP
  ) {
    limits.push(currentSize);
  }

  if (limits[limits.length - 1] !== MIN_IMAGE_DIMENSION) {
    limits.push(MIN_IMAGE_DIMENSION);
  }

  return limits;
};

const RESIZE_LIMITS = buildResizeLimits();

const encodeImageVariant = async (buffer, dimensionLimit, quality) => {
  const transformer = sharp(buffer, { failOn: "none" })
    .rotate()
    .resize({
      width: dimensionLimit,
      height: dimensionLimit,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({
      quality,
      effort: 4,
      smartSubsample: true,
    });

  const { data, info } = await transformer.toBuffer({ resolveWithObject: true });

  return {
    buffer: data,
    bytes: data.length,
    width: info.width,
    height: info.height,
    format: info.format,
    quality,
    dimensionLimit,
  };
};

const chooseBestVariant = async (buffer) => {
  let bestVariant = null;

  for (const dimensionLimit of RESIZE_LIMITS) {
    for (const quality of WEBP_QUALITY_STEPS) {
      const variant = await encodeImageVariant(buffer, dimensionLimit, quality);

      if (!bestVariant || variant.bytes < bestVariant.bytes) {
        bestVariant = variant;
      }

      if (variant.bytes <= TARGET_IMAGE_BYTES) {
        return {
          ...variant,
          targetMet: true,
        };
      }
    }
  }

  if (bestVariant && bestVariant.bytes <= MAX_IMAGE_BYTES) {
    return {
      ...bestVariant,
      targetMet: false,
    };
  }

  throw new Error(
    "Image could not be compressed below 500 KB. Please upload a smaller image.",
  );
};

const processUploadedImage = async (file) => {
  if (!file?.buffer) {
    throw new Error("Image file buffer is required");
  }

  const optimizedVariant = await chooseBestVariant(file.buffer);
  const baseName = sanitizeBaseName(file.originalname || "image");

  return {
    ...optimizedVariant,
    fileName: `${baseName}.webp`,
    mimeType: "image/webp",
  };
};

module.exports = {
  MAX_IMAGE_BYTES,
  TARGET_IMAGE_BYTES,
  processUploadedImage,
};
