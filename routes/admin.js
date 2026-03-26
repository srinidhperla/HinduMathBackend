const express = require("express");
const { auth, isAdmin } = require("../middleware/auth");
const { sendTestAlertEmail } = require("../controllers/siteController");

const router = express.Router();

router.post("/test-email", auth, isAdmin, sendTestAlertEmail);

module.exports = router;
