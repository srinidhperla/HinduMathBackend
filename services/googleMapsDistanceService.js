const logger = require("../utils/logger");

const GOOGLE_DISTANCE_MATRIX_URL =
  "https://maps.googleapis.com/maps/api/distancematrix/json";

const toCoordinate = (value, min, max) => {
  const numericValue = Number(value);
  if (
    !Number.isFinite(numericValue) ||
    numericValue < min ||
    numericValue > max
  ) {
    return null;
  }

  return numericValue;
};

const getGoogleMapsKey = () =>
  String(
    process.env.GOOGLE_MAPS_API_KEY ||
      process.env.VITE_GOOGLE_MAPS_API_KEY ||
      "",
  ).trim();

const getElementErrorMessage = (element = {}) =>
  String(
    element?.error_message ||
      element?.status ||
      "Google distance matrix could not compute a driving route.",
  ).trim();

const parseDistanceMatrixPayload = (payload = {}) => {
  const element = payload?.rows?.[0]?.elements?.[0];
  const distanceMeters = Number(element?.distance?.value);
  const durationSeconds = Number(element?.duration?.value);

  if (element?.status !== "OK" || !Number.isFinite(distanceMeters)) {
    throw new Error(getElementErrorMessage(element));
  }

  return {
    distanceKm: distanceMeters / 1000,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
  };
};

const validateCoordinates = (coords, label) => {
  if (!coords || typeof coords !== "object") {
    return `${label} coordinates are missing.`;
  }
  const lat = toCoordinate(coords.lat, -90, 90);
  const lng = toCoordinate(coords.lng, -180, 180);
  if (lat === null) {
    return `${label} latitude is invalid (must be a number between -90 and 90).`;
  }
  if (lng === null) {
    return `${label} longitude is invalid (must be a number between -180 and 180).`;
  }
  return null;
};

const fetchDrivingDistance = async ({ origin, destination }) => {
  const originError = validateCoordinates(origin, "Origin");
  const destinationError = validateCoordinates(destination, "Destination");

  if (originError || destinationError) {
    throw new Error(originError || destinationError);
  }

  const originLat = toCoordinate(origin.lat, -90, 90);
  const originLng = toCoordinate(origin.lng, -180, 180);
  const destinationLat = toCoordinate(destination.lat, -90, 90);
  const destinationLng = toCoordinate(destination.lng, -180, 180);

  const apiKey = getGoogleMapsKey();
  if (!apiKey) {
    throw new Error("Google Maps API key missing.");
  }

  const params = new URLSearchParams({
    origins: `${originLat},${originLng}`,
    destinations: `${destinationLat},${destinationLng}`,
    mode: "driving",
    units: "metric",
    key: apiKey,
  });

  const url = `${GOOGLE_DISTANCE_MATRIX_URL}?${params.toString()}`;

  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
      },
    });
  } catch (error) {
    logger.error("Google distance matrix request failed", {
      url,
      error: error.message,
    });
    throw new Error("Unable to calculate driving distance right now.");
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(
      String(
        payload?.error_message ||
          payload?.message ||
          "Google distance matrix request failed.",
      ).trim(),
    );
  }

  if (String(payload?.status || "").trim() !== "OK") {
    throw new Error(
      String(
        payload?.error_message ||
          payload?.status ||
          "Google distance matrix request failed.",
      ).trim(),
    );
  }

  return parseDistanceMatrixPayload(payload);
};

module.exports = {
  fetchDrivingDistance,
  parseDistanceMatrixPayload,
};
