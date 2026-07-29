const mongoose = require("mongoose");
const logger = require("../utils/logger");

// Configure Mongoose global settings
mongoose.set("strictQuery", true);

const ORDER_PAYMENT_ID_INDEX_NAME = "paymentGatewayPaymentId_1";
const RETRY_DELAY_MS = Number(process.env.MONGO_RETRY_DELAY_MS || 5000);

const ensureOrderPaymentIdIndex = async () => {
  const Order = require("../models/Order");
  const blankPaymentIdOrders = await Order.find({
    paymentGatewayPaymentId: {
      $type: "string",
      $regex: /^\s*$/,
    },
  })
    .select("_id")
    .lean();

  if (blankPaymentIdOrders.length > 0) {
    await Order.updateMany(
      {
        _id: {
          $in: blankPaymentIdOrders.map((order) => order._id),
        },
      },
      {
        $unset: {
          paymentGatewayPaymentId: 1,
        },
      },
    );

    logger.info("Removed blank payment gateway payment IDs from orders", {
      updatedCount: blankPaymentIdOrders.length,
    });
  }

  const indexes = await Order.collection.indexes();
  const paymentIdIndex = indexes.find(
    (index) =>
      index.name === ORDER_PAYMENT_ID_INDEX_NAME ||
      JSON.stringify(index.key) === JSON.stringify({ paymentGatewayPaymentId: 1 }),
  );
  const expectedPartialFilter = {
    paymentGatewayPaymentId: {
      $exists: true,
      $type: "string",
    },
  };
  const hasExpectedIndex =
    paymentIdIndex &&
    paymentIdIndex.unique === true &&
    JSON.stringify(paymentIdIndex.partialFilterExpression || {}) ===
      JSON.stringify(expectedPartialFilter);

  if (!hasExpectedIndex && paymentIdIndex) {
    await Order.collection.dropIndex(paymentIdIndex.name);
    logger.info("Dropped outdated order payment ID index", {
      indexName: paymentIdIndex.name,
    });
  }

  if (!hasExpectedIndex) {
    await Order.collection.createIndex(
      { paymentGatewayPaymentId: 1 },
      {
        name: ORDER_PAYMENT_ID_INDEX_NAME,
        unique: true,
        partialFilterExpression: expectedPartialFilter,
      },
    );
    logger.info("Created order payment ID index", {
      indexName: ORDER_PAYMENT_ID_INDEX_NAME,
    });
  }
};

const connectDB = async (attempt = 1) => {
  const uri = process.env.DATABASE_URL;

  if (!uri) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  try {
    await mongoose.connect(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    await ensureOrderPaymentIdIndex();
    logger.info("Connected to MongoDB", {
      database: mongoose.connection.name,
    });
    return true;
  } catch (error) {
    logger.error("MongoDB connection error", {
      error: error.message,
      attempt,
    });

    const maxAttempts = Number(process.env.MONGO_MAX_RETRIES || 0);
    if (maxAttempts > 0 && attempt >= maxAttempts) {
      throw error;
    }

    logger.warn(`Retrying MongoDB connection in ${RETRY_DELAY_MS / 1000} seconds`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return connectDB(attempt + 1);
  }
};

module.exports = connectDB;
