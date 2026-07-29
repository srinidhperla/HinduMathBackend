const CONTENT_TYPE_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

const slugify = (value = "", fallback = "item") =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;

// Cloudinary delivery URLs often carry no extension, and base64 data URIs never
// do, so the response content type is the more reliable source.
const resolveExtension = (url = "", contentType = "") => {
  const normalizedType = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (CONTENT_TYPE_EXTENSIONS[normalizedType]) {
    return CONTENT_TYPE_EXTENSIONS[normalizedType];
  }

  const match = String(url || "").split("?")[0].match(/\.([a-zA-Z0-9]{2,5})$/);
  return (match?.[1] || "jpg").toLowerCase();
};

const downloadImage = async (imageUrl) => {
  const response = await fetch(imageUrl);

  if (!response.ok) {
    throw new Error(`Image download returned HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length === 0) {
    throw new Error("Image download returned an empty file");
  }

  return { buffer, contentType };
};

/**
 * Cheap liveness probe: HEAD returns the status without transferring the image
 * body, so checking costs effectively no Cloudinary bandwidth.
 */
const isImageAlive = async (imageUrl) => {
  const url = String(imageUrl || "").trim();

  if (!url) {
    return false;
  }

  // Inline base64 lives in MongoDB, so it can never be missing from Cloudinary.
  if (url.startsWith("data:")) {
    return true;
  }

  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
};

/**
 * Numbers entries per category so files sort predictably inside each folder.
 */
const createCategorySequencer = () => {
  const counts = new Map();

  return (categorySlug) => {
    const next = (counts.get(categorySlug) || 0) + 1;
    counts.set(categorySlug, next);
    return String(next).padStart(2, "0");
  };
};

const buildManifest = ({ kind, totalItems, included, failed }) => ({
  kind,
  createdAt: new Date().toISOString(),
  totalItems,
  includedCount: included.length,
  failedCount: failed.length,
  included,
  failed,
});

const MANIFEST_NAME = "_manifest.json";

const isManifestEntry = (entryName = "") =>
  String(entryName).endsWith(MANIFEST_NAME);

module.exports = {
  MANIFEST_NAME,
  buildManifest,
  createCategorySequencer,
  downloadImage,
  isImageAlive,
  isManifestEntry,
  resolveExtension,
  slugify,
};
