const express = require("express");
const { standardReadLimiter } = require("../middleware/rateLimiters");
const {
  searchPlaces,
  textSearch,
  geocodeAddress,
  reverseGeocode,
  distanceMatrix,
} = require("../controllers/mapsController");

const router = express.Router();

router.get("/search", standardReadLimiter, searchPlaces);
router.get("/text-search", standardReadLimiter, textSearch);
router.get("/geocode", standardReadLimiter, geocodeAddress);
router.get("/reverse-geocode", standardReadLimiter, reverseGeocode);
router.get("/distance-matrix", standardReadLimiter, distanceMatrix);

module.exports = router;
