// Shared small-indicator primitives — a rank/round badge, a legend dot, and
// a category filter pill. These four shapes used to be redefined slightly
// differently in Scoreboard.jsx, DraftRecap.jsx, and Trends.jsx; pulling
// them here keeps the visual language (corner radius, tint/border formula)
// in one place so a future change to "what a badge looks like" only needs
// to happen once.
import { theme } from "../constants/theme";

// A small tinted, bordered indicator holding a short label — used for the
// #1 rank badge (circle) and the draft round badge (rounded square).
export function Badge({ children, color, shape = "rounded", size = 26, bgAlpha = "18", borderAlpha = "35" }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: size, height: size, flexShrink: 0,
      borderRadius: shape === "circle" ? "50%" : 7,
      background: color + bgAlpha,
      border: `1.5px solid ${color}${borderAlpha}`,
      color, fontWeight: 800, fontSize: size <= 22 ? 11 : 12,
    }}>
      {children}
    </span>
  );
}

// A small solid color swatch — used in Trends' member legend.
export function Dot({ color, size = 7 }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: "50%",
      background: color, display: "inline-block", flexShrink: 0,
    }} />
  );
}

// A pill-shaped filter button — used for the Overall/category row on both
// Scoreboard and Trends.
export function CategoryPill({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 10px", borderRadius: 20, flexShrink: 0,
      border: "1px solid " + (active ? theme.acc : theme.bdr),
      background: active ? theme.acc : theme.card,
      color: active ? "#1A1200" : theme.txt,
      fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
    }}>
      {children}
    </button>
  );
}
