const logger = require("../utils/logger");

const GOOGLE_AUTOCOMPLETE_URL =
  "https://maps.googleapis.com/maps/api/place/autocomplete/json";
const GOOGLE_TEXTSEARCH_URL =
  "https://maps.googleapis.com/maps/api/place/textsearch/json";
const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const GOOGLE_DISTANCE_MATRIX_URL =
  "https://maps.googleapis.com/maps/api/distancematrix/json";

const getGoogleMapsKey = (req) =>
  String(
    req.get("x-google-maps-key") ||
      process.env.GOOGLE_MAPS_API_KEY ||
      process.env.VITE_GOOGLE_MAPS_API_KEY ||
      "",
  ).trim();

const parsePayload = async (response) => {
  const rawText = await response.text();
  if (!rawText) {
    return null;
  }

  try {
    return JSON.parse(rawText);
  } catch {
    return { raw: rawText };
  }
};

const getErrorMessage = (payload, fallbackMessage) =>
  String(
    payload?.error_message ||
      payload?.message ||
      payload?.error_description ||
      payload?.error ||
      fallbackMessage,
  ).trim();

const forwardRequest = async (res, url, fallbackMessage) => {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
      },
    });

    const payload = await parsePayload(response);

    if (!response.ok) {
      return res.status(response.status).json({
        message: getErrorMessage(payload, fallbackMessage),
        error: payload?.error || "",
        error_description: payload?.error_description || "",
      });
    }

    return res.json(payload || {});
  } catch (error) {
    logger.error("Google Maps proxy request failed", {
      url,
      error: error.message,
    });
    return res.status(502).json({
      message: fallbackMessage,
      error: error.message,
    });
  }
};

const requireGoogleMapsKey = (req, res) => {
  const apiKey = getGoogleMapsKey(req);
  if (!apiKey) {
    res.status(400).json({ message: "Google Maps API key missing" });
    return "";
  }

  return apiKey;
};

exports.searchPlaces = async (req, res) => {
  const apiKey = requireGoogleMapsKey(req, res);
  if (!apiKey) return;

  const query = String(req.query.query || "")
    .trim()
    .slice(0, 500);
  if (!query) {
    return res.status(400).json({ message: "query is required" });
  }

  const location = String(req.query.location || "")
    .trim()
    .slice(0, 100);
  const radius = Math.min(
    Math.max(parseInt(req.query.radius, 10) || 30000, 1),
    50000,
  );

  const params = new URLSearchParams({
    input: query,
    key: apiKey,
    components: `country:${String(req.query.country || "in").slice(0, 5)}`,
  });

  if (location) {
    params.set("location", location);
    params.set("radius", String(radius));
  }

  return forwardRequest(
    res,
    `${GOOGLE_AUTOCOMPLETE_URL}?${params}`,
    "Google place search failed",
  );
};

exports.textSearch = async (req, res) => {
  const apiKey = requireGoogleMapsKey(req, res);
  if (!apiKey) return;

  const query = String(req.query.query || "").trim();
  if (!query) {
    return res.status(400).json({ message: "query is required" });
  }

  const params = new URLSearchParams({
    query,
    key: apiKey,
  });

  if (String(req.query.location || "").trim()) {
    params.set("location", String(req.query.location).trim());
  }

  if (String(req.query.radius || "").trim()) {
    params.set("radius", String(req.query.radius).trim());
  }

  return forwardRequest(
    res,
    `${GOOGLE_TEXTSEARCH_URL}?${params}`,
    "Google text search failed",
  );
};

exports.geocodeAddress = async (req, res) => {
  const apiKey = requireGoogleMapsKey(req, res);
  if (!apiKey) return;

  const address = String(req.query.address || "").trim();
  const placeId = String(req.query.place_id || "").trim();

  if (!address && !placeId) {
    return res.status(400).json({ message: "address or place_id is required" });
  }

  const params = new URLSearchParams({ key: apiKey });
  if (placeId) {
    params.set("place_id", placeId);
  } else {
    params.set("address", address);
  }

  return forwardRequest(
    res,
    `${GOOGLE_GEOCODE_URL}?${params}`,
    "Google geocoding failed",
  );
};

exports.reverseGeocode = async (req, res) => {
  const apiKey = requireGoogleMapsKey(req, res);
  if (!apiKey) return;

  const lat = String(req.query.lat || "").trim();
  const lng = String(req.query.lng || "").trim();

  if (!lat || !lng) {
    return res.status(400).json({ message: "lat and lng are required" });
  }

  const params = new URLSearchParams({
    latlng: `${lat},${lng}`,
    key: apiKey,
  });

  return forwardRequest(
    res,
    `${GOOGLE_GEOCODE_URL}?${params}`,
    "Google reverse geocoding failed",
  );
};

exports.distanceMatrix = async (req, res) => {
  const apiKey = requireGoogleMapsKey(req, res);
  if (!apiKey) return;

  const origin = String(req.query.origin || "").trim();
  const destination = String(req.query.destination || "").trim();

  if (!origin || !destination) {
    return res.status(400).json({
      message: "origin and destination are required",
    });
  }

  const params = new URLSearchParams({
    origins: origin,
    destinations: destination,
    mode: "driving",
    units: "metric",
    key: apiKey,
  });

  return forwardRequest(
    res,
    `${GOOGLE_DISTANCE_MATRIX_URL}?${params}`,
    "Google distance matrix failed",
  );
};
