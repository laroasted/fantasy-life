import { useLayoutEffect } from "react";
import { Trophy, Bell, BellOff, Settings as SettingsIcon } from "lucide-react";
import { theme, font, space } from "../constants/theme";
import { MEMBER_COLORS } from "../constants/members";
import { track, EVENTS } from "../utils/analytics";
import { getContrastText } from "../utils/helpers";

// ── App navigation shell ──
//
// Replaces the old sticky top header + horizontally-scrolling tab bar with
// a persistent left rail (desktop) / bottom tab bar (mobile) — the single
// biggest structural change in this redesign. Everything that used to live
// in App.jsx's header (logo, push bell, account menu, refresh, settings
// gear, the TABS row) now lives here; App.jsx keeps every bit of the state
// and the handlers, this component just lays them out differently.
//
// `tabs` is passed in rather than imported, since it's App.jsx's own TABS
// array — importing it here instead would mean this file reaching back
// into App.jsx, which already imports this one.
export default function AppShell({
  tabs,
  activeTab,
  setActiveTab,
  isMobile,
  pushSupported,
  pushEnabled,
  pushToggling,
  handlePushToggle,
  authReady,
  commissionerSession,
  showAccountMenu,
  setShowAccountMenu,
  memberId,
  accountDisplayName,
  isCommissioner,
  claimError,
  unclaimedMembers,
  claimingId,
  handleClaimMember,
  handleCommissionerSignOut,
  authLoading,
  authError,
  setAuthError,
  handleGoogleSignIn,
  handleRefresh,
  refreshing,
  children,
}) {
  // Reset scroll on every tab change, before paint. Without this, leaving
  // a long, scrolled-down tab for one whose content is (even briefly)
  // shorter shrinks the document below the current scroll offset, and
  // iOS WebKit's scroll clamp drags the fixed bottom bar up for several
  // frames before snapping back: the "hopping" bar. Layout effect, not
  // a plain effect, so the first painted frame of the new tab is
  // already at the top.
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [activeTab]);

  function goToTab(id) {
    track(EVENTS.TAB_VIEWED, { tab_name: id, previous_tab: activeTab, is_mobile: isMobile });
    setActiveTab(id);
  }

  // ── Account menu — shared between the rail trigger (desktop) and the
  // condensed mobile header; same dropdown, same click-away overlay, same
  // behavior as before, just rendered from one place instead of copied. ──
  function AccountMenu({ compact }) {
    if (!authReady) return null;
    return (
      <div style={{ position: "relative", flexShrink: 0, width: compact ? "auto" : "100%" }}>
        {commissionerSession ? (
          <>
            <button
              onClick={() => setShowAccountMenu((v) => !v)}
              style={{
                display: "flex", alignItems: "center", gap: space.sm, minWidth: 0,
                width: "100%", boxSizing: "border-box",
                background: "none",
                border: "1px solid " + theme.bdr,
                borderRadius: 8,
                padding: space.sm,
                color: theme.txt,
                cursor: "pointer",
                font: "inherit",
              }}>
              <span style={{
                width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
                background: (memberId && MEMBER_COLORS[memberId]) || theme.dim,
                color: getContrastText((memberId && MEMBER_COLORS[memberId]) || theme.dim),
                fontSize: 11, fontWeight: 700,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                {(accountDisplayName || "?").charAt(0).toUpperCase()}
              </span>
              {(!isMobile || compact) && (
                <span style={{ fontSize: 11, fontWeight: 700, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {accountDisplayName || "Set your name"}
                </span>
              )}
            </button>
            {showAccountMenu && (
              <>
                <div onClick={() => setShowAccountMenu(false)}
                  style={{ position: "fixed", inset: 0, zIndex: 150 }} />
                <div style={{
                  position: "absolute", top: "calc(100% + 6px)", left: 0,
                  background: theme.card, border: "1px solid " + theme.bdr,
                  borderRadius: 10, padding: space.sm, minWidth: 220,
                  zIndex: 151, boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                }}>
                  {isCommissioner && (
                    <div style={{ fontSize: 11, color: "#86efac", fontWeight: 700, marginBottom: space.sm }}>
                      Commissioner
                    </div>
                  )}
                  {memberId ? (
                    <div style={{ fontSize: 11, color: theme.dim, marginBottom: space.sm }}>
                      Signed in as {accountDisplayName}
                    </div>
                  ) : (
                    <div style={{ marginBottom: space.sm }}>
                      <div style={{ fontSize: 11, color: theme.dim, marginBottom: space.xs }}>
                        Which of these are you?
                      </div>
                      {claimError && (
                        <div style={{ fontSize: 10, color: "#fca5a5", marginBottom: space.xs }}>
                          {claimError}
                        </div>
                      )}
                      <div style={{ display: "flex", flexDirection: "column", gap: space.xs, maxHeight: 220, overflowY: "auto" }}>
                        {unclaimedMembers.map((m) => (
                          <button key={m.id}
                            onClick={() => handleClaimMember(m.id)}
                            disabled={!!claimingId}
                            style={{
                              textAlign: "left",
                              background: "none", border: "1px solid " + theme.bdr,
                              borderRadius: 6, padding: `${space.xs}px ${space.sm}px`,
                              color: theme.txt, fontSize: 12,
                              cursor: claimingId ? "default" : "pointer",
                              opacity: claimingId === m.id ? 0.6 : 1,
                            }}>
                            {m.name}
                          </button>
                        ))}
                        {unclaimedMembers.length === 0 && (
                          <div style={{ fontSize: 11, color: theme.dim }}>
                            Everyone's claimed — ask the commissioner if yours is wrong.
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  <button
                    onClick={() => { setShowAccountMenu(false); handleCommissionerSignOut(); }}
                    disabled={authLoading}
                    style={{
                      width: "100%",
                      background: "none", border: "1px solid " + theme.bdr,
                      borderRadius: 8, padding: space.sm,
                      color: theme.txt, fontSize: 11,
                      cursor: authLoading ? "default" : "pointer",
                    }}>
                    Sign out
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <button
            onClick={() => { setAuthError(""); handleGoogleSignIn(); }}
            disabled={authLoading}
            style={{
              width: "100%", boxSizing: "border-box",
              background: "none",
              border: "1px solid " + theme.bdr,
              borderRadius: 8,
              padding: space.sm,
              color: theme.txt,
              fontSize: 11,
              fontWeight: 700,
              cursor: authLoading ? "default" : "pointer",
              opacity: authLoading ? 0.6 : 1,
            }}>
            {authLoading ? "Redirecting…" : "Sign in with Google"}
          </button>
        )}
        {authError && (
          <div style={{
            position: "absolute", top: "100%", left: 0,
            marginTop: 4, fontSize: 10, color: "#fca5a5", whiteSpace: "nowrap",
          }}>
            {authError}
          </div>
        )}
      </div>
    );
  }

  // Icon-only chrome buttons (bell, refresh, settings) — 44x44px minimum
  // touch target everywhere this renders on a touch surface (mobile
  // header, mobile account-menu row), not just visually sized to fit the
  // icon. Desktop rail can afford to size these a bit smaller since mouse
  // precision isn't the same constraint.
  function IconButton({ onClick, title, active, size, disabled, children: icon }) {
    return (
      <button onClick={onClick} title={title} aria-label={title} disabled={disabled}
        style={{
          background: "none",
          border: "1px solid " + (active ? theme.acc : theme.bdr),
          borderRadius: 8,
          width: size, height: size, flexShrink: 0,
          color: disabled ? theme.dim : active ? theme.acc : theme.dim,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.6 : 1,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
        {icon}
      </button>
    );
  }

  const railButtonStyle = (isActive) => ({
    display: "flex", alignItems: "center", gap: space.sm, width: "100%",
    padding: `${space.sm}px ${space.md}px`, borderRadius: 8, margin: `0 0 ${space.xs}px`,
    background: isActive ? theme.accSoft : "none",
    border: "none", textAlign: "left", font: "inherit",
    color: isActive ? theme.acc : theme.dim,
    fontSize: 13, fontWeight: isActive ? 700 : 500,
    cursor: "pointer",
  });

  const refreshButton = (
    <IconButton onClick={handleRefresh} disabled={refreshing} title={refreshing ? "Refreshing..." : "Refresh"} size={isMobile ? 44 : 32}>
      <span style={{ display: "inline-block", animation: refreshing ? "spin 1s linear infinite" : "none" }}>↻</span>
    </IconButton>
  );
  const settingsButton = (
    <IconButton onClick={() => goToTab("settings")} title="Settings" active={activeTab === "settings"} size={isMobile ? 44 : 32}>
      <SettingsIcon size={15} />
    </IconButton>
  );
  const bellButton = pushSupported && (
    <IconButton onClick={handlePushToggle} disabled={pushToggling}
      title={pushToggling ? "Updating…" : pushEnabled ? "Turn off notifications" : "Get notified about score updates"}
      active={pushEnabled} size={isMobile ? 44 : 32}>
      {pushEnabled ? <Bell size={15} /> : <BellOff size={15} />}
    </IconButton>
  );

  if (isMobile) {
    return (
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        {/* Condensed mobile header — logo + account/bell/refresh/settings,
            every icon button a real 44x44px touch target. */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: space.sm, padding: `${space.sm}px ${space.md}px`,
          background: theme.card, borderBottom: "1px solid " + theme.bdr,
          position: "sticky", top: "env(safe-area-inset-top, 0px)", zIndex: 100,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
            <Trophy size={20} color={theme.acc} style={{ flexShrink: 0 }} />
            <h1 style={{ fontSize: 14, fontWeight: 800, margin: 0, color: "#FAFAFA",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Fantasy Life</h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexShrink: 0 }}>
            {bellButton}
            {refreshButton}
            <AccountMenu compact />
            {settingsButton}
          </div>
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>

        {/* Bottom clearance = floating bar height (52) + its offset from
            the screen edge + a little breathing room, so the last row of
            content can still scroll fully clear of the bar. minHeight keeps
            the document from ever being shorter than the viewport (the
            other half of the anti-hop fix above). */}
        <div style={{
          padding: `${space.md}px ${space.sm}px calc(84px + env(safe-area-inset-bottom, 0px))`,
          minHeight: "100dvh",
        }}>{children}</div>

        {/* Floating pill tab bar (Facebook-style): inset from both sides,
            sitting partly inside the home-indicator safe area instead of
            stacked fully above it, translucent + blurred so content shows
            through above, below and behind it. translateZ(0) gives it its
            own compositor layer, which keeps WebKit from repainting it
            mid-scroll. */}
        <nav aria-label="Main" style={{
          position: "fixed", zIndex: 100,
          left: space.md, right: space.md,
          bottom: "max(8px, calc(env(safe-area-inset-bottom, 0px) - 14px))",
          height: 52, padding: 4,
          display: "flex", gap: 2,
          background: "rgba(20, 25, 34, 0.78)",
          backdropFilter: "blur(16px) saturate(160%)",
          WebkitBackdropFilter: "blur(16px) saturate(160%)",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          borderRadius: 26,
          boxShadow: "0 6px 24px rgba(0, 0, 0, 0.45)",
          transform: "translateZ(0)",
        }}>
          {tabs.map((t) => {
            const isActive = activeTab === t.id;
            return (
              <button key={t.id} onClick={() => goToTab(t.id)}
                aria-current={isActive ? "page" : undefined}
                aria-label={t.label}
                style={{
                  flex: 1, minWidth: 0, display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center", gap: 2,
                  background: isActive ? theme.accSoft : "none",
                  border: "none", borderRadius: 22, font: "inherit",
                  color: isActive ? theme.acc : theme.dim,
                  fontSize: 9.5, fontWeight: isActive ? 700 : 500, cursor: "pointer",
                  WebkitTapHighlightColor: "transparent",
                }}>
                <t.Icon size={19} />
                <span style={{ lineHeight: 1, whiteSpace: "nowrap" }}>{t.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1280, margin: "0 auto", display: "flex", alignItems: "flex-start" }}>
      {/* Left rail — persistent nav, replaces the old top tab bar. Account-
          first ordering (logo, then account/bell/settings, then nav) —
          same order validated against the mockup earlier in this
          redesign. */}
      <div style={{
        width: 220, flexShrink: 0, padding: `${space.lg}px ${space.sm}px`,
        position: "sticky", top: "env(safe-area-inset-top, 0px)",
        // No maxHeight/overflowY here on purpose — per the CSS overflow
        // spec, once either axis is auto/scroll, the browser forces the
        // OTHER axis to auto too, even if it's explicitly set to
        // "visible" (confirmed: getComputedStyle still reported
        // overflowX as "auto" with overflowX:"visible" stated). There's
        // no way to keep one axis scrollable and the other genuinely
        // unclipped on the same element — only a real fix (no overflow
        // constraint at all here) lets the account dropdown float out
        // over the main content instead of getting clipped. Five nav
        // items plus the account row never come close to needing to
        // scroll within 100vh on any real screen, so nothing is lost.
        display: "flex", flexDirection: "column", gap: space.xs,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `0 ${space.xs}px ${space.md}px`,
          fontSize: 18, fontWeight: 800, fontFamily: font.display, color: "#FAFAFA" }}>
          <Trophy size={24} color={theme.acc} style={{ flexShrink: 0 }} />
          Fantasy Life
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `0 ${space.xs}px ${space.md}px`, minWidth: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}><AccountMenu /></div>
          {bellButton}
          {settingsButton}
        </div>
        <nav aria-label="Main" style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {tabs.map((t) => {
            const isActive = activeTab === t.id;
            return (
              <button key={t.id} onClick={() => goToTab(t.id)}
                aria-current={isActive ? "page" : undefined}
                style={railButtonStyle(isActive)}>
                <t.Icon size={16} />
                <span>{t.label}</span>
              </button>
            );
          })}
        </nav>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>

      <div style={{ flex: 1, minWidth: 0, padding: `${space.lg}px ${space.md}px` }}>
        {children}
      </div>
    </div>
  );
}
