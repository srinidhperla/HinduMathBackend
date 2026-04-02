const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseDistanceMatrixPayload,
} = require("./googleMapsDistanceService");

test("parseDistanceMatrixPayload returns kilometers and seconds", () => {
  const result = parseDistanceMatrixPayload({
    rows: [
      {
        elements: [
          {
            status: "OK",
            distance: { value: 6400 },
            duration: { value: 1080 },
          },
        ],
      },
    ],
  });

  assert.equal(result.distanceKm, 6.4);
  assert.equal(result.durationSeconds, 1080);
});

test("parseDistanceMatrixPayload throws when Google does not return a route", () => {
  assert.throws(
    () =>
      parseDistanceMatrixPayload({
        rows: [
          {
            elements: [
              {
                status: "ZERO_RESULTS",
              },
            ],
          },
        ],
      }),
    /ZERO_RESULTS/,
  );
});
