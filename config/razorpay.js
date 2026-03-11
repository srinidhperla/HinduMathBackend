const Razorpay = require("razorpay");

const RAZORPAY_KEY_ID =
  process.env.RAZORPAY_KEY || process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";

const razorpayClient =
  RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: RAZORPAY_KEY_ID,
        key_secret: RAZORPAY_KEY_SECRET,
      })
    : null;

module.exports = { razorpayClient, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET };
