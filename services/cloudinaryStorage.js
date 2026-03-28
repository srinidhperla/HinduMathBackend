const { v2: cloudinary } = require("cloudinary");
const logger = require("../utils/logger");

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;
const DEFAULT_FOLDER = process.env.CLOUDINARY_FOLDER || "bakery";

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
  if (parts[0].startsWith("v") && /^\d+$/.test(parts[0].slice(1))) {
    parts.shift();
  }

  const withoutExt = parts.join("/").replace(/\.[^.]+$/, "");
  return withoutExt || null;
};

module.exports = { isConfigured, uploadFile, deleteFile, extractFileId };
