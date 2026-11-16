// Shared "centered icon + heading + body" card — the recipe every empty
// state, error state, auth gate, and flow intro on this app independently
// reinvented (Trends' load failure, Calendar's empty season, the Settings
// commissioner gate, DraftRecap's load failure/empty board, DraftTool's
// New Season Draft intro). Pulling it into one place means a future change
// to that recipe happens once, and it's the same fix pattern Badges.jsx
// already applied to the smaller indicator primitives — see that file's
// own comment for the precedent.
import { theme, cardStyle } from "../constants/theme";

export default function StatusCard({
  icon: Icon,
  iconSize = 28,
  iconColor = theme.dim,
  headingLevel = 3,
  titleSize,
  title,
  children,
  action,
  footer,
  maxWidth = 420,
  padding = 40,
  centered = true,
}) {
  var Heading = "h" + headingLevel;
  return (
    <div style={Object.assign({}, cardStyle, {
      maxWidth: maxWidth,
      margin: centered ? "0 auto" : undefined,
      textAlign: "center",
      padding: padding,
    })}>
      {Icon && <Icon size={iconSize} color={iconColor} style={{ marginBottom: 10 }} />}
      {title && (
        <Heading style={{ margin: children ? "0 0 8px" : 0, fontSize: titleSize || (headingLevel === 2 ? 22 : 16) }}>
          {title}
        </Heading>
      )}
      {children && (
        <div style={{ color: theme.dim, fontSize: 13, maxWidth: 360, margin: "0 auto" }}>
          {children}
        </div>
      )}
      {action && (
        <button onClick={action.onClick} style={{
          marginTop: 14, background: "none", border: "1px solid " + theme.bdr, borderRadius: 8,
          padding: "7px 16px", color: theme.txt, fontSize: 12, fontWeight: 700, cursor: "pointer",
        }}>
          {action.label}
        </button>
      )}
      {footer && <div style={{ marginTop: 16, textAlign: "left" }}>{footer}</div>}
    </div>
  );
}
