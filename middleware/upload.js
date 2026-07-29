const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
      return;
    }

    cb(new Error("Only image uploads are allowed"));
  },
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

const uploadArchive = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const isZip =
      file.mimetype === "application/zip" ||
      file.mimetype === "application/x-zip-compressed" ||
      file.originalname.toLowerCase().endsWith(".zip");

    if (isZip) {
      cb(null, true);
      return;
    }

    cb(new Error("Only .zip archives are allowed"));
  },
  limits: {
    fileSize: 200 * 1024 * 1024,
  },
});

module.exports = upload;
module.exports.uploadArchive = uploadArchive;
