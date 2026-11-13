const { v2: cloudinary } = require("cloudinary");
const cloudinaryStorage = require("./cloudinaryStorage");
const logger = require("../utils/logger");

/* ── Purchase bills: totals, file storage and reading a bill with AI ──── */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/* Work out each line and the bill totals. Rates are before tax. */
const computePurchase = ({ lines, taxType, otherCharges, lessDiscount = 0, roundOff }) => {
  const computed = lines.map((line) => {
    const taxable = round2(line.qty * line.rate - (line.discount || 0));
    const gst = round2((taxable * (line.gstRate || 0)) / 100);
    return { ...line, taxable, gst, amount: round2(taxable + gst) };
  });
  const taxable = round2(computed.reduce((sum, line) => sum + line.taxable, 0));
  const gst = round2(computed.reduce((sum, line) => sum + line.gst, 0));
  const cgst = taxType === "inter" ? 0 : round2(gst / 2);
  const sgst = taxType === "inter" ? 0 : round2(gst - cgst);
  const igst = taxType === "inter" ? gst : 0;
  const extra = round2(otherCharges);
  const less = round2(lessDiscount);
  const rounding = round2(roundOff);
  return {
    lines: computed,
    taxable,
    gst,
    cgst,
    sgst,
    igst,
    otherCharges: extra,
    lessDiscount: less,
    roundOff: rounding,
    total: round2(taxable + gst + extra - less + rounding),
  };
};

/* ── Bill files ──────────────────────────────────────────────────────────
 * Kept in Cloudinary beside the website images, in their own folder.
 * Photos and PDFs go up as images (so they can be previewed); Excel and CSV
 * as raw files. */

const SHEET_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/csv",
  "text/plain",
];

const fileKind = (file) => {
  const name = String(file.originalname || "").toLowerCase();
  if (file.mimetype.startsWith("image/")) return "image";
  if (file.mimetype === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (SHEET_TYPES.includes(file.mimetype) || /\.(xlsx|xls|csv)$/.test(name)) {
    return "sheet";
  }
  return "";
};

const storeBillFile = async (file) => {
  if (!cloudinaryStorage.isConfigured()) {
    throw Object.assign(new Error("File storage (Cloudinary) is not set up on the server."), {
      statusCode: 503,
    });
  }
  const kind = fileKind(file);
  const resourceType = kind === "sheet" ? "raw" : "image";
  const folder = `${process.env.CLOUDINARY_FOLDER || "bakery"}/purchase-bills`;
  const base = String(file.originalname || "bill")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .slice(0, 60);
  const extension = kind === "sheet" ? (file.originalname.match(/\.[^.]+$/) || [""])[0] : "";

  const result = await new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        {
          folder,
          resource_type: resourceType,
          public_id: `${Date.now()}-${base || "bill"}${extension}`,
        },
        (error, uploaded) => (error ? reject(error) : resolve(uploaded)),
      )
      .end(file.buffer);
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
    resourceType,
    mimeType: file.mimetype,
    fileName: String(file.originalname || "").slice(0, 120),
  };
};

const removeBillFile = async (attachment) => {
  if (!attachment?.publicId || !cloudinaryStorage.isConfigured()) return;
  try {
    await cloudinary.uploader.destroy(attachment.publicId, {
      resource_type: attachment.resourceType || "image",
    });
  } catch (error) {
    logger.error("Purchase bill file delete failed", { error: error.message });
  }
};

const normaliseName = (name) =>
  String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

module.exports = {
  round2,
  computePurchase,
  fileKind,
  storeBillFile,
  removeBillFile,
  normaliseName,
};
