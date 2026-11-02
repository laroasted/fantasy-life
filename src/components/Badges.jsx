// Shared small-indicator primitives — a rank/round badge, a legend dot, and
// a category filter pill. These four shapes used to be redefined slightly
// differently in Scoreboard.jsx, DraftRecap.jsx, and Trends.jsx; pulling
// them here keeps the visual language (corner radius, tint/border formula)
// in one place so a future change to "what a badge looks like" only needs
// to happen once.
//
// Every export is wrapped in React.memo — these are pure leaf components
// (same props in, same markup out) rendered many times per screen (one
// Avatar/RankBadge per roster row, one CategoryPill per category), so a
// parent re-render that doesn't actually change their props (a resize, a
// toast timer, a realtime-triggered reload elsewhere on the page) no
// longer re-renders every one of them too.
import { memo } from "react";
import { theme } from "../constants/theme";

// A small tinted, bordered indicator holding a short label — used for the
// #1 rank badge (circle) and the draft round badge (rounded square).
function BadgeBase({ children, color, shape = "rounded", size = 26, bgAlpha = "18", borderAlpha = "35" }) {
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
export const Badge = memo(BadgeBase);

// A colored-circle initials avatar — stands in for a profile photo (this
// app has no upload flow yet) so a member reads as a person rather than
// a name + color swatch. Initials are the first letter of each
// space-separated word in the display name, capped at 2 (display names
// here are mostly single words — "Marsh", "Auzy" — so this is usually
// just one letter; "LaRosa" and multi-word names still resolve sensibly).
function AvatarBase({ name, color, size = 28 }) {
  var initials = (name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(function (w) { return w[0]; })
    .join("")
    .toUpperCase() || "?";
  var c = color || "#64748b";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: size, height: size, flexShrink: 0,
      borderRadius: "50%",
      background: c + "26", border: `1.5px solid ${c}55`,
      color: c, fontWeight: 800, fontSize: Math.max(9, Math.round(size * 0.38)),
    }}>
      {initials}
    </span>
  );
}
export const Avatar = memo(AvatarBase);

// A shimmering placeholder block, shaped (via width/height/radius) like
// whatever real content is about to replace it — swap in for a bare
// "Loading…" string wherever a tab fetches its own data (Trends, Calendar,
// ActivityFeed, DraftRecap each do). A layout-matching skeleton reads as
// "this is already loading, hold on" where plain text reads as "nothing
// happened yet" even when the wait is identical.
function SkeletonBase({ width = "100%", height = 14, radius: r = 6, style }) {
  return (
    <span style={Object.assign({
      display: "block", width: width, height: height, borderRadius: r,
      flexShrink: 0,
      background: "linear-gradient(90deg, #1A202B 25%, #232A36 37%, #1A202B 63%)",
      backgroundSize: "400% 100%",
      animation: "skeletonShimmer 1.4s ease infinite",
    }, style)} />
  );
}
export const Skeleton = memo(SkeletonBase);

// A small solid color swatch — used in Trends' member legend.
function DotBase({ color, size = 7 }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: "50%",
      background: color, display: "inline-block", flexShrink: 0,
    }} />
  );
}
export const Dot = memo(DotBase);

// A pill-shaped filter button — used for the Overall/category row on both
// Scoreboard and Trends.
function CategoryPillBase({ active, onClick, children }) {
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
export const CategoryPill = memo(CategoryPillBase);
