const express = require("express");
const http = require("http");
const compression = require("compression");
const cors = require("cors");
const helmet = require("helmet");
const mongoSanitize = require("express-mongo-sanitize");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const path = require("path");
const { Server } = require("socket.io");

// Load environment variables before importing app modules that read process.env
dotenv.config({ path: path.resolve(__dirname, ".env") });
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

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
const { initCache, getCacheStatus } = require("./services/cacheStore");

validateEnv();

// Create Express app
const app = express();
const server = http.createServer(app);

// Required behind reverse proxies (Render, Nginx, etc.) so req.ip and rate limits work.
app.set("trust proxy", 1);

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    frameguard: { action: "deny" },
    noSniff: true,
    hsts:
      process.env.NODE_ENV === "production"
        ? {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true,
          }
        : false,
  }),
);
app.use(mongoSanitize());
app.use(compression());
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  );
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (process.env.NODE_ENV === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload",
    );
  }
  next();
});

// CORS
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
  : [
      "http://localhost:5173",
      "http://localhost:3000",
      "https://hindumatha.me",
      "https://www.hindumatha.me",
    ];

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
      socket.data.user = null;
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId)
      .select("_id role name")
      .lean();

    if (!user) {
      return next(new Error("Authentication required"));
    }

    socket.data.user = user;
    return next();
  } catch (error) {
    return next(new Error("Authentication failed"));
  }
});

io.on("connection", (socket) => {
  const user = socket.data?.user;

  if (user?.role === "admin") {
    socket.join("admin-orders");
  }

  if (user?._id) {
    socket.join(`user-orders:${user._id}`);
  }

  if (user?.role === "delivery" && user?._id) {
    socket.join(`delivery-orders:${user._id}`);
  }

  socket.emit("connected", {
    ok: true,
    role: user?.role || "user",
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
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});
app.get("/api/health", (req, res) => {
  const cacheStatus = getCacheStatus();

  res.json({
    status: "ok",
    cache: cacheStatus.cache,
    redisConnected: cacheStatus.redisConnected,
  });
});

// Routes
app.use("/api", routes);

// Error handling middleware
app.use(errorHandler);

// Connect to MongoDB and start server
const PORT = process.env.PORT || 5000;

connectDB()
  .then(async () => {
    await initCache();
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
