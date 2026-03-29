const { createClient } = require("redis");
const logger = require("../utils/logger");

const DEFAULT_TTL_SECONDS = 300;
const CACHE_PREFIX = "public:";
const memoryCache = new Map();
let redisClient = null;
let redisReady = false;
let memoryCleanupTimer = null;

const buildCacheKey = (key) => `${CACHE_PREFIX}${key}`;

const getMemoryEntry = (key) => {
  const entry = memoryCache.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }

  return entry.value;
};

const setMemoryEntry = (key, value, ttlSeconds = DEFAULT_TTL_SECONDS) => {
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + Number(ttlSeconds || DEFAULT_TTL_SECONDS) * 1000,
  });
};

const cleanupExpiredMemoryEntries = () => {
  const now = Date.now();
  for (const [key, entry] of memoryCache.entries()) {
    if (entry.expiresAt <= now) {
      memoryCache.delete(key);
    }
  }
};

const removeByPrefixes = (prefixes = []) => {
  const normalized = prefixes.filter(Boolean);
  if (!normalized.length) {
    return;
  }

  for (const key of memoryCache.keys()) {
    if (normalized.some((prefix) => key.startsWith(prefix))) {
      memoryCache.delete(key);
    }
  }
};

const initializeMemoryCleanup = () => {
  if (memoryCleanupTimer) {
    return;
  }

  memoryCleanupTimer = setInterval(cleanupExpiredMemoryEntries, 60 * 1000);
  if (typeof memoryCleanupTimer.unref === "function") {
    memoryCleanupTimer.unref();
  }
};

const findRedisKeysByPrefix = async (prefix) => {
  if (!redisReady || !redisClient) {
    return [];
  }

  const keys = [];
  let cursor = "0";
  do {
    const result = await redisClient.scan(cursor, {
      MATCH: `${prefix}*`,
      COUNT: 100,
    });
    cursor = result.cursor;
    keys.push(...(result.keys || []));
  } while (cursor !== "0");

  return keys;
};

const initCache = async () => {
  initializeMemoryCleanup();
  const redisUrl = String(process.env.REDIS_URL || "").trim();

  if (!redisUrl) {
    logger.info("REDIS_URL not configured. Using in-memory cache.");
    return;
  }

  try {
    redisClient = createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 100, 2000),
      },
    });

    redisClient.on("error", (error) => {
      redisReady = false;
      logger.warn("Redis cache error. Falling back to memory cache.", {
        error: error?.message || String(error),
      });
    });

    redisClient.on("ready", () => {
      redisReady = true;
      logger.info("Redis cache connected.");
    });

    redisClient.on("end", () => {
      redisReady = false;
      logger.warn("Redis cache disconnected. Using memory cache fallback.");
    });

    await redisClient.connect();
    redisReady = true;
  } catch (error) {
    redisClient = null;
    redisReady = false;
    logger.warn("Redis unavailable. Using in-memory cache fallback.", {
      error: error?.message || String(error),
    });
  }
};

const getCachedJson = async (key) => {
  const cacheKey = buildCacheKey(key);

  if (redisReady && redisClient) {
    try {
      const raw = await redisClient.get(cacheKey);
      if (!raw) {
        return null;
      }

      return JSON.parse(raw);
    } catch (error) {
      logger.warn("Redis read failed. Falling back to memory cache.", {
        key: cacheKey,
        error: error?.message || String(error),
      });
    }
  }

  return getMemoryEntry(cacheKey);
};

const setCachedJson = async (key, payload, ttlSeconds = DEFAULT_TTL_SECONDS) => {
  const cacheKey = buildCacheKey(key);

  if (redisReady && redisClient) {
    try {
      await redisClient.setEx(
        cacheKey,
        Number(ttlSeconds || DEFAULT_TTL_SECONDS),
        JSON.stringify(payload),
      );
      return;
    } catch (error) {
      logger.warn("Redis write failed. Storing in memory cache.", {
        key: cacheKey,
        error: error?.message || String(error),
      });
    }
  }

  setMemoryEntry(cacheKey, payload, ttlSeconds);
};

const clearPublicApiCache = async () => {
  const prefixes = [buildCacheKey("products"), buildCacheKey("site")];

  removeByPrefixes(prefixes);

  if (!redisReady || !redisClient) {
    return;
  }

  try {
    for (const prefix of prefixes) {
      const keys = await findRedisKeysByPrefix(prefix);
      if (keys.length) {
        await redisClient.del(keys);
      }
    }
  } catch (error) {
    logger.warn("Failed to clear Redis public cache keys.", {
      error: error?.message || String(error),
    });
  }
};

module.exports = {
  DEFAULT_TTL_SECONDS,
  clearPublicApiCache,
  getCachedJson,
  initCache,
  setCachedJson,
};
