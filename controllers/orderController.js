const orderWriteController = require("./orders/orderWriteController");
const orderReadController = require("./orders/orderReadController");
const orderAdminController = require("./orders/orderAdminController");

module.exports = {
  ...orderWriteController,
  ...orderReadController,
  ...orderAdminController,
};
