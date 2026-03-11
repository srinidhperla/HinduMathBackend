const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toFiniteNumber = (value) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
};

const haversineDistance = (lat1, lng1, lat2, lng2) => {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
};

const isWithinDeliveryRadius = (
  storeLocation,
  deliveryLat,
  deliveryLng,
  maxRadiusKm,
) => {
  const storeLat = toFiniteNumber(storeLocation?.lat);
  const storeLng = toFiniteNumber(storeLocation?.lng);
  const customerLat = toFiniteNumber(deliveryLat);
  const customerLng = toFiniteNumber(deliveryLng);
  const radius = toFiniteNumber(maxRadiusKm);

  if (storeLat === null || storeLng === null) return true;
  if (storeLat === 0 && storeLng === 0) return true;
  if (customerLat === null || customerLng === null) return false;
  if (radius === null || radius <= 0) return true;

  const distance = haversineDistance(
    storeLat,
    storeLng,
    customerLat,
    customerLng,
  );

  return distance <= radius;
};

module.exports = { haversineDistance, isWithinDeliveryRadius };
