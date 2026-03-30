const { v2: cloudinary } = require("cloudinary");
const logger = require("../utils/logger");

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;
const DEFAULT_FOLDER = process.env.CLOUDINARY_FOLDER || "bakery";
const DEFAULT_DELIVERY_TRANSFORMS = "f_auto,q_auto,c_limit,w_800";
const UPLOAD_PATH_MARKER = "/image/upload/";

const isConfigured = () => Boolean(CLOUD_NAME && API_KEY && API_SECRET);

if (isConfigured()) {
  cloudinary.config({
    cloud_name: CLOUD_NAME,
    api_key: API_KEY,
    api_secret: API_SECRET,
  });
}

const sanitizePublicId = (name) => {
  const base = String(name || "image").replace(/\.[^.]+$/, "");
  const cleaned = base.replace(/[^a-zA-Z0-9/_-]+/g, "-");
  const collapsed = cleaned.replace(/--+/g, "-").replace(/^-+|-+$/g, "");
  return collapsed || `image-${Date.now()}`;
};

const isCloudinaryTransformSegment = (segment = "") =>
  /(?:^|,)(?:a|ar|b|bo|c|co|dpr|e|f|fl|g|h|o|q|r|t|w|x|y|z)_[^,]+/i.test(
    String(segment || ""),
  );

const optimizeDeliveryUrl = (
  imageUrl,
  transforms = DEFAULT_DELIVERY_TRANSFORMS,
) => {
  const source = String(imageUrl || "").trim();
  if (!source || !/^https?:\/\/res\.cloudinary\.com\//i.test(source)) {
    return source;
  }

  try {
    const parsed = new URL(source);
    const uploadIndex = parsed.pathname.indexOf(UPLOAD_PATH_MARKER);
    if (uploadIndex < 0) {
      return source;
    }

    const beforeUpload = parsed.pathname.slice(
      0,
      uploadIndex + UPLOAD_PATH_MARKER.length,
    );
    const afterUploadParts = parsed.pathname
      .slice(uploadIndex + UPLOAD_PATH_MARKER.length)
      .split("/")
      .filter(Boolean);

    const remainingParts = [...afterUploadParts];
    if (remainingParts.length > 0 && isCloudinaryTransformSegment(remainingParts[0])) {
      remainingParts.shift();
    }

    parsed.pathname = `${beforeUpload}${transforms}/${remainingParts.join("/")}`;
    return parsed.toString();
  } catch {
    return source;
  }
};

const uploadFile = async (buffer, fileName, _mimeType) => {
  if (!isConfigured()) {
    throw new Error("Cloudinary is not configured");
  }

  const publicId = sanitizePublicId(fileName);
  const uploadOptions = {
    resource_type: "image",
    public_id: publicId,
  };

  if (DEFAULT_FOLDER) {
    uploadOptions.folder = DEFAULT_FOLDER;
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          logger.error(`Cloudinary upload failed: ${error.message}`);
          reject(error);
          return;
        }

        resolve({ fileId: result.public_id, url: result.secure_url });
      },
    );

    stream.end(buffer);
  });
};

const deleteFile = async (fileId) => {
  if (!fileId || !isConfigured()) {
    return;
  }

  try {
    await cloudinary.uploader.destroy(fileId, { resource_type: "image" });
    logger.info(`Cloudinary image deleted: ${fileId}`);
  } catch (error) {
    logger.error(`Cloudinary delete failed (${fileId}): ${error.message}`);
  }
};

const extractFileId = (url) => {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("data:")) return null;
  if (!url.includes("res.cloudinary.com")) return null;

  const clean = url.split("?")[0];
  const uploadIndex = clean.indexOf("/upload/");
  if (uploadIndex === -1) return null;

  const pathAfterUpload = clean.substring(uploadIndex + "/upload/".length);
  const parts = pathAfterUpload.split("/").filter(Boolean);

  if (parts.length === 0) return null;
  if (parts.length > 0 && isCloudinaryTransformSegment(parts[0])) {
    parts.shift();
  }
  if (parts[0].startsWith("v") && /^\d+$/.test(parts[0].slice(1))) {
    parts.shift();
  }

  const withoutExt = parts.join("/").replace(/\.[^.]+$/, "");
  return withoutExt || null;
};

module.exports = {
  DEFAULT_DELIVERY_TRANSFORMS,
  extractFileId,
  deleteFile,
  isConfigured,
  optimizeDeliveryUrl,
  uploadFile,
};
