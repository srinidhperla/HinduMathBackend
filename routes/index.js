const express = require("express");

const router = express.Router();

router.use("/auth", require("./auth"));
router.use("/products", require("./products"));
router.use("/orders", require("./orders"));
router.use("/site", require("./site"));

module.exports = router;
