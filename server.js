const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const mongoSanitize = require("express-mongo-sanitize");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const path = require("path");
const { Server } = require("socket.io");
const connectDB = require("./config/database");
const { validateEnv } = require("./config/env");
const { standardReadLimiter } = require("./middleware/rateLimiters");
const User = require("./models/User");
const errorHandler = require("./middleware/errorHandler");
const requestLogger = require("./middleware/requestLogger");
const logger = require("./utils/logger");
const routes = require("./routes");
const {
  startOrderReminderService,
} = require("./services/orderReminderService");
const { setOrderEventSocketServer } = require("./services/orderEvents");

// Load environment variables
dotenv.config();
validateEnv();

// Create Express app
const app = express();
const server = http.createServer(app);

// Security middleware
app.use(helmet());
app.use(mongoSanitize());

// CORS
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",")
  : ["http://localhost:5173", "http://localhost:3000"];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

io.use(async (socket, next) => {
  try {
    const authHeader = socket.handshake.headers?.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token ||
      bearerToken;

    if (!token) {
      return next(new Error("Authentication required"));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId)
      .select("_id role name")
      .lean();

    if (!user || user.role !== "admin") {
      return next(new Error("Admin access required"));
    }

    socket.data.user = user;
    return next();
  } catch (error) {
    return next(new Error("Authentication failed"));
  }
});

io.on("connection", (socket) => {
  socket.join("admin-orders");
  socket.emit("connected", {
    ok: true,
    timestamp: new Date().toISOString(),
  });
});

setOrderEventSocketServer(io);

// Body parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(requestLogger);

// Serve local uploads (fallback when Appwrite not configured)
app.use("/uploads", express.static(path.join(__dirname, "public", "uploads")));

// Apply rate limiting
app.use("/api", standardReadLimiter);

// Routes
app.use("/api", routes);

// Error handling middleware
app.use(errorHandler);

// Connect to MongoDB and start server
const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    startOrderReminderService();

    server.on("error", (error) => {
      if (error?.code === "EADDRINUSE") {
        logger.error(
          `Port ${PORT} is already in use. Stop the running server or set a different PORT in backend/.env.`,
        );
        process.exit(1);
      }

      logger.error("Server startup error", { error: error?.message || error });
      process.exit(1);
    });

    server.listen(PORT, () => {
      logger.info(`Server is running on port ${PORT}`);
    });
  })
  .catch((err) => {
    logger.error("MongoDB connection error", { error: err.message });
    process.exit(1);
  });
