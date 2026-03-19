// Fantasy Life Hub — Theme & style helpers

// Color tokens
export const theme = {
  bg: "#0f172a",
  card: "#1e293b",
  srf: "#334155",
  bdr: "#334155",
  txt: "#f1f5f9",
  dim: "#94a3b8",
  mut: "#64748b",
  acc: "#3b82f6",
  grn: "#22c55e",
  red: "#ef4444",
  yel: "#eab308",
};

// Card style
export const cardStyle = {
  background: theme.card,
  border: `1px solid ${theme.bdr}`,
  borderRadius: 12,
  padding: 16,
};

// Input style
export const inputStyle = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: `1px solid ${theme.bdr}`,
  background: theme.srf,
  color: theme.txt,
  fontSize: 14,
  outline: "none",
  boxSizing: "border-box",
};

// Button style factory
export function buttonStyle(color) {
  return {
    padding: "10px 16px",
    borderRadius: 8,
    border: "none",
    background: color || theme.acc,
    color: "#fff",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  };
}
