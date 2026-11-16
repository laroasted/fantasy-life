// Regenerates the hex values in src/constants/members.js (MEMBER_COLORS /
// NEW_MEMBER_COLORS). Not run automatically — rerun by hand only if the
// member roster, the saturation/lightness recipe, or the app's semantic
// colors (theme.js) change enough to warrant new values, then paste the
// output back into members.js. See the comment above MEMBER_COLORS for the
// reasoning (fixed S/L, hue step chosen to clear theme.js's semantic hues).
//
// Usage: node scripts/gen-member-colors.js

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
  return "#" + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
}

const MEMBER_IDS = ["adam", "dhruv", "marsh", "jordan", "alan", "evan", "larosa", "jack", "mike", "danny", "auzy"];
const START_HUE = 16.5;
const STEP = 360 / 11;
const SATURATION = 72;
const LIGHTNESS = 56;
const NEW_MEMBER_COUNT = 8;

console.log("MEMBER_COLORS:");
MEMBER_IDS.forEach((id, i) => {
  const hue = Math.round((START_HUE + i * STEP) % 360);
  console.log(`  ${id}: "${hslToHex(hue, SATURATION, LIGHTNESS)}", // hue ${hue}`);
});

console.log("\nNEW_MEMBER_COLORS (half-step offset):");
for (let i = 0; i < NEW_MEMBER_COUNT; i++) {
  const hue = Math.round((START_HUE + STEP / 2 + i * STEP) % 360);
  console.log(`  "${hslToHex(hue, SATURATION, LIGHTNESS)}", // hue ${hue}`);
}
