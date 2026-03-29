const {
  DEFAULT_TTL_SECONDS,
  getCachedJson,
  setCachedJson,
} = require("../services/cacheStore");

const buildStableQueryKey = (query = {}) => {
  const keys = Object.keys(query || {}).sort();
  if (!keys.length) {
    return "";
  }

  const params = new URLSearchParams();
  keys.forEach((key) => {
    const value = query[key];
    if (Array.isArray(value)) {
      value.forEach((item) => params.append(key, String(item)));
      return;
    }

    if (value !== undefined && value !== null && value !== "") {
      params.append(key, String(value));
    }
  });

  return params.toString();
};

const cacheResponse =
  ({ key, ttlSeconds = DEFAULT_TTL_SECONDS }) =>
  async (req, res, next) => {
    if (req.method !== "GET") {
      return next();
    }

    const cacheKey =
      typeof key === "function" ? key(req) : String(key || "").trim();

    if (!cacheKey) {
      return next();
    }

    try {
      const cachedPayload = await getCachedJson(cacheKey);
      if (cachedPayload !== null) {
        res.setHeader("X-Cache", "HIT");
        return res.json(cachedPayload);
      }
    } catch (_) {
      // Fail open and continue to handler when cache lookup fails.
    }

    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        res.setHeader("X-Cache", "MISS");
        setCachedJson(cacheKey, payload, ttlSeconds).catch(() => null);
      }
      return originalJson(payload);
    };

    return next();
  };

module.exports = {
  buildStableQueryKey,
  cacheResponse,
};
