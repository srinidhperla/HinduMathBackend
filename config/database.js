const mongoose = require("mongoose");
const logger = require("../utils/logger");

const connectDB = async () => {
  const uri = process.env.DATABASE_URL;

  await mongoose.connect(uri);
  logger.info("Connected to MongoDB", {
    database: mongoose.connection.name,
  });
};

module.exports = connectDB;
