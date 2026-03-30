const GALLERY_IMAGE_URLS = Object.freeze({
  cake1:
    "https://res.cloudinary.com/dh39jlcy0/image/upload/f_auto,q_auto,w_800/product_images/gallery/cake1",
  cake2:
    "https://res.cloudinary.com/dh39jlcy0/image/upload/f_auto,q_auto,w_800/product_images/gallery/cake2",
  cake3:
    "https://res.cloudinary.com/dh39jlcy0/image/upload/f_auto,q_auto,w_800/product_images/gallery/cake3",
  cake4:
    "https://res.cloudinary.com/dh39jlcy0/image/upload/f_auto,q_auto,w_800/product_images/gallery/cake4",
  cake5:
    "https://res.cloudinary.com/dh39jlcy0/image/upload/f_auto,q_auto,w_800/product_images/gallery/cake5",
  cake6:
    "https://res.cloudinary.com/dh39jlcy0/image/upload/f_auto,q_auto,w_800/product_images/gallery/cake6",
  cake7:
    "https://res.cloudinary.com/dh39jlcy0/image/upload/f_auto,q_auto,w_800/product_images/gallery/cake7",
  cake8:
    "https://res.cloudinary.com/dh39jlcy0/image/upload/f_auto,q_auto,w_800/product_images/gallery/cake8",
});

const GALLERY_IMAGE_BY_LOCAL_PATH = Object.freeze({
  "/images/gallery/cake1.jpg": GALLERY_IMAGE_URLS.cake1,
  "/images/gallery/cake2.jpg": GALLERY_IMAGE_URLS.cake2,
  "/images/gallery/cake3.jpg": GALLERY_IMAGE_URLS.cake3,
  "/images/gallery/cake4.jpg": GALLERY_IMAGE_URLS.cake4,
  "/images/gallery/cake5.jpg": GALLERY_IMAGE_URLS.cake5,
  "/images/gallery/cake6.jpg": GALLERY_IMAGE_URLS.cake6,
  "/images/gallery/cake7.jpg": GALLERY_IMAGE_URLS.cake7,
  "/images/gallery/cake8.jpg": GALLERY_IMAGE_URLS.cake8,
});

const normalizeGalleryPath = (value = "") => {
  const source = String(value || "").trim();
  if (!source) {
    return "";
  }

  const cleanSource = source.split(/[?#]/, 1)[0];
  if (/^images\/gallery\//i.test(cleanSource)) {
    return `/${cleanSource}`.toLowerCase();
  }

  if (/^\/images\/gallery\//i.test(cleanSource)) {
    return cleanSource.toLowerCase();
  }

  try {
    const parsed = new URL(source);
    if (/^\/images\/gallery\//i.test(parsed.pathname)) {
      return parsed.pathname.toLowerCase();
    }
  } catch {
    return "";
  }

  return "";
};

const resolveGalleryImageUrl = (value = "") => {
  const normalizedPath = normalizeGalleryPath(value);
  if (!normalizedPath) {
    return String(value || "").trim();
  }

  return GALLERY_IMAGE_BY_LOCAL_PATH[normalizedPath] || String(value || "").trim();
};

module.exports = {
  GALLERY_IMAGE_URLS,
  resolveGalleryImageUrl,
};

