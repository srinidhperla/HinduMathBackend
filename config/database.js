const mongoose = require("mongoose");
const logger = require("../utils/logger");

// Configure Mongoose global settings
mongoose.set("strictQuery", true);

const connectDB = async () => {
  const uri = process.env.DATABASE_URL;

  if (!uri) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  await mongoose.connect(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
  logger.info("Connected to MongoDB", {
    database: mongoose.connection.name,
  });
};

module.exports = connectDB;
