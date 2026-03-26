const express = require("express");

const router = express.Router();

router.use("/auth", require("./auth"));
router.use("/products", require("./products"));
router.use("/orders", require("./orders"));
router.use("/site", require("./site"));
router.use("/admin", require("./admin"));
router.use("/maps", require("./maps"));

module.exports = router;
