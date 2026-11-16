// Fantasy Life Hub — Theme & style helpers
//
// bdr is a plain 6-digit hex (not rgba) on purpose — a few call sites build
// a translucent variant by string-appending an alpha suffix (`${theme.bdr}22`),
// which only produces valid CSS when bdr itself has no alpha component.

// Color tokens
export const theme = {
  bg: "#0B0E14",
  card: "#141922",
  srf: "#1E2430",
  bdr: "#262B34",
  txt: "#F2F3F5",
  dim: "#9A9AA2",
  mut: "#7D8590",
  acc: "#F2B84B",
  accSoft: "rgba(242,184,74,0.14)",
  grn: "#22c55e",
  red: "#ef4444",
  yel: "#eab308",
  you: "#3b82f6", // fixed "this is your row" accent — same for every signed-in
                  // member, independent of their own MEMBER_COLORS entry.
  up: "#38bdf8",   // category-strength "high" tick — blue, not green. Distinct
                   // from grn/red above (those mean win/loss elsewhere, e.g.
                   // Stock's pctChange bar) so this pairing stays colorblind-
                   // safe without touching that unrelated semantic.
  down: "#fb923c", // category-strength "low" tick — orange, not red.
};

// Typography — two families, one job each (loaded in public/index.html;
// that file's comment has the full rationale). `display` is for the
// handful of spots that are headline/numeral register, not body copy —
// h1/h2/h3 already get it for free via the global CSS rule in
// index.html, so reach for `font.display` in a style object only for
// something that isn't a real heading tag (the Scoreboard's big score
// totals, the AppShell wordmark). Everything else inherits `font.body`
// from the <body> rule and never needs to set fontFamily at all.
export const font = {
  display: "'Space Grotesk', system-ui, sans-serif",
  body: "'Public Sans', system-ui, -apple-system, sans-serif",
};

// Type scale — sizes below `sm` are for things that are genuinely
// secondary at a glance (a timestamp, a badge, a tooltip note), never for
// anything a user is meant to actually read. `base` is the floor for real
// reading content (names, labels, body copy) — anything smaller than that
// for primary content is the bug this scale exists to stop reintroducing.
export const type = {
  xs: 10,   // badges, tooltips, fine print
  sm: 12,   // secondary/supporting labels
  base: 14, // primary reading content (names, category labels, body copy)
  md: 16,   // section sub-headers, emphasized content
  lg: 20,   // card titles
  xl: 28,   // page-level numerals (score totals)
};

// Spacing scale — every margin/padding/gap in this app used to be picked
// per element by feel (10, 6, 14, 5, 9, 7, 3... with no relationship to
// each other), which is the actual reason two adjacent cards' gaps never
// quite look intentional next to each other. Multiples of 8, the same
// discipline radius/shadow below already apply to corners and elevation.
// Not retrofitted everywhere yet (that's a large, separate pass across
// ~250 existing call sites) — use this for anything new, and migrate a
// file's literals to it when you're already touching that file's layout.
export const space = {
  xs: 4,   // tight inline gaps (icon-to-label)
  sm: 8,   // control padding, small gaps
  md: 16,  // card padding, standard gaps between elements
  lg: 24,  // gaps between distinct sections
  xl: 40,  // page-level top/bottom breathing room
};

// Radius scale — pick one of these three for anything new instead of a
// one-off number: sm for controls (buttons, inputs, tabs), md for
// cards/tiles/panels, pill for fully-rounded chips and badges.
export const radius = {
  sm: 8,
  md: 12,
  pill: 999,
};

// Elevation — real shadows instead of a flat 1px border standing in for depth.
export const shadow = {
  sm: "0 1px 0 rgba(255,255,255,.04) inset, 0 4px 10px rgba(0,0,0,.35)",
  md: "0 1px 0 rgba(255,255,255,.04) inset, 0 10px 24px rgba(0,0,0,.42)",
  lg: "0 1px 0 rgba(255,255,255,.04) inset, 0 20px 44px rgba(0,0,0,.5)",
};

// Card style
export const cardStyle = {
  background: theme.card,
  borderRadius: radius.md,
  padding: 16,
  boxShadow: shadow.md,
};

// Input style
export const inputStyle = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: radius.sm,
  border: `1px solid ${theme.bdr}`,
  background: theme.srf,
  color: theme.txt,
  fontSize: 14,
  outline: "none",
  boxSizing: "border-box",
};

// Button style factory. Amber is light, so it gets dark ink; every other
// explicit color (theme.grn/red/yel/srf, all darker/more saturated) keeps
// white text as before.
export function buttonStyle(color) {
  var bg = color || theme.acc;
  var onAmber = bg === theme.acc;
  return {
    padding: "10px 16px",
    borderRadius: radius.sm,
    border: "none",
    background: bg,
    color: onAmber ? "#1A1200" : "#fff",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  };
}
