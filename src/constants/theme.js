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
