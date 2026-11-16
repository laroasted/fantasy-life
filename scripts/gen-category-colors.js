// Regenerates the hex values in src/constants/categories.js
// (CATEGORY_COLORS). Not run automatically — rerun by hand only if the
// category list, the saturation/lightness recipe, or theme.js's semantic
// colors change enough to warrant new values, then paste the output back
// into categories.js. See the comment above CATEGORY_COLORS for the
// reasoning. Mirrors scripts/gen-member-colors.js's approach.
//
// Usage: node scripts/gen-category-colors.js

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
  return "#" + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
}

const CATEGORY_KEYS = [
  "NFL", "MLB", "NBA", "NHL", "NCAAF", "NCAAB", "MLS",
  "Tennis", "Golf", "F1", "Actor", "Actress", "Musician",
  "Country", "Stock", "Film",
];
const START_HUE = 10.5;
const STEP = 360 / CATEGORY_KEYS.length;
const SATURATION = 68;
const LIGHTNESS = 54;

console.log("CATEGORY_COLORS:");
CATEGORY_KEYS.forEach((key, i) => {
  const hue = Math.round((START_HUE + i * STEP) % 360);
  console.log(`  ${key}: "${hslToHex(hue, SATURATION, LIGHTNESS)}", // hue ${hue}`);
});
