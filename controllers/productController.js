const productReadController = require("./products/productReadController");
const productWriteController = require("./products/productWriteController");
const productAdminController = require("./products/productAdminController");

module.exports = {
  ...productReadController,
  ...productWriteController,
  ...productAdminController,
};
