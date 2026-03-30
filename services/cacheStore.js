const { Redis } = require("@upstash/redis");
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

const normalizeRedisUrl = (value = "") => {
  const source = String(value || "").trim();
  if (!source) {
    return "";
  }

  try {
    const parsed = new URL(source);
    if (parsed.protocol === "redis:") {
      parsed.protocol = "rediss:";
    }
    return parsed.toString();
  } catch {
    return source.replace(/^redis:\/\//i, "rediss://");
  }
};

const toRedisUrlPreview = (value = "") => {
  const source = String(value || "").trim();
  if (!source) {
    return "not-set";
  }

  return `${source.slice(0, 20)}${source.length > 20 ? "..." : ""}`;
};

const resolveUpstashCredentials = (normalizedRedisUrl) => {
  const explicitRestUrl = String(
    process.env.UPSTASH_REDIS_REST_URL || "",
  ).trim();
  const explicitRestToken = String(
    process.env.UPSTASH_REDIS_REST_TOKEN || "",
  ).trim();

  if (explicitRestUrl && explicitRestToken) {
    return {
      url: explicitRestUrl,
      token: explicitRestToken,
    };
  }

  if (!normalizedRedisUrl) {
    return null;
  }

  try {
    const parsed = new URL(normalizedRedisUrl);
    if (!String(parsed.hostname || "").toLowerCase().endsWith("upstash.io")) {
      return null;
    }

    const inferredToken = decodeURIComponent(parsed.password || "").trim();
    if (!inferredToken) {
      return null;
    }

    return {
      url: `https://${parsed.hostname}`,
      token: inferredToken,
    };
  } catch {
    return null;
  }
};

const isRedisAvailable = () => redisReady && redisClient;

const normalizeScanResponse = (response) => {
  if (Array.isArray(response)) {
    const [cursor, keys] = response;
    return {
      cursor: Number(cursor) || 0,
      keys: Array.isArray(keys) ? keys : [],
    };
  }

  return {
    cursor: Number(response?.cursor) || 0,
    keys: Array.isArray(response?.keys) ? response.keys : [],
  };
};

const findRedisKeysByPrefix = async (prefix) => {
  if (!isRedisAvailable()) {
    return [];
  }

  const keys = [];
  let cursor = 0;
  do {
    const response = await redisClient.scan(cursor, {
      match: `${prefix}*`,
      count: 100,
    });
    const normalized = normalizeScanResponse(response);
    cursor = normalized.cursor;
    keys.push(...normalized.keys);
  } while (cursor !== 0);

  return keys;
};

const deleteRedisKeys = async (keys = []) => {
  const normalizedKeys = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  if (!normalizedKeys.length || !isRedisAvailable()) {
    return;
  }

  await redisClient.del(...normalizedKeys);
};

const initCache = async () => {
  initializeMemoryCleanup();

  const rawRedisUrl = String(process.env.REDIS_URL || "").trim();
  const normalizedRedisUrl = normalizeRedisUrl(rawRedisUrl);
  logger.info(`REDIS_URL preview: ${toRedisUrlPreview(normalizedRedisUrl)}`);

  const upstashCredentials = resolveUpstashCredentials(normalizedRedisUrl);
  if (!upstashCredentials) {
    redisClient = null;
    redisReady = false;
    logger.info("Redis not available using memory cache");
    return;
  }

  try {
    redisClient = new Redis({
      url: upstashCredentials.url,
      token: upstashCredentials.token,
    });
    await redisClient.ping();
    redisReady = true;
    logger.info("Redis connected successfully");
  } catch (error) {
    redisClient = null;
    redisReady = false;
    logger.warn("Redis not available using memory cache", {
      error: error?.message || String(error),
    });
  }
};

const getCacheStatus = () => ({
  cache: isRedisAvailable() ? "redis" : "memory",
  redisConnected: Boolean(isRedisAvailable()),
});

const parseCachedPayload = (rawValue) => {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return null;
  }

  if (typeof rawValue === "string") {
    return JSON.parse(rawValue);
  }

  if (typeof rawValue === "object") {
    return rawValue;
  }

  return JSON.parse(String(rawValue));
};

const getCachedJson = async (key) => {
  const cacheKey = buildCacheKey(key);

  if (isRedisAvailable()) {
    try {
      const raw = await redisClient.get(cacheKey);
      return parseCachedPayload(raw);
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
  const safeTtl = Number(ttlSeconds || DEFAULT_TTL_SECONDS);

  if (isRedisAvailable()) {
    try {
      await redisClient.set(cacheKey, JSON.stringify(payload), {
        ex: safeTtl,
      });
      return;
    } catch (error) {
      logger.warn("Redis write failed. Storing in memory cache.", {
        key: cacheKey,
        error: error?.message || String(error),
      });
    }
  }

  setMemoryEntry(cacheKey, payload, safeTtl);
};

const clearPublicApiCache = async () => {
  const prefixes = [buildCacheKey("products"), buildCacheKey("site")];

  removeByPrefixes(prefixes);

  if (!isRedisAvailable()) {
    return;
  }

  try {
    for (const prefix of prefixes) {
      const keys = await findRedisKeysByPrefix(prefix);
      if (keys.length) {
        await deleteRedisKeys(keys);
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
  getCacheStatus,
  initCache,
  setCachedJson,
};
