const mongoose = require("mongoose");

const connectDB = async () => {
  const uri = process.env.DATABASE_URL;

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");
  console.log(`MongoDB database: ${mongoose.connection.name}`);
};

module.exports = connectDB;
