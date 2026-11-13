import { Trophy, Bell, BellOff, Settings as SettingsIcon } from "lucide-react";
import { theme } from "../constants/theme";
import { MEMBER_COLORS } from "../constants/members";
import { track, EVENTS } from "../utils/analytics";

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
      <div style={{ position: "relative", flexShrink: 0 }}>
        {commissionerSession ? (
          <>
            <button
              onClick={() => setShowAccountMenu((v) => !v)}
              style={{
                display: "flex", alignItems: "center", gap: 6, minWidth: 0,
                width: compact ? "100%" : "auto",
                background: "none",
                border: "1px solid " + theme.bdr,
                borderRadius: 8,
                padding: "6px 8px",
                color: theme.txt,
                cursor: "pointer",
                font: "inherit",
              }}>
              <span style={{
                width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
                background: (memberId && MEMBER_COLORS[memberId]) || theme.dim,
                color: "#fff", fontSize: 11, fontWeight: 700,
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
                  position: "absolute", top: "calc(100% + 6px)",
                  left: compact ? 0 : undefined, right: compact ? undefined : 0,
                  background: theme.card, border: "1px solid " + theme.bdr,
                  borderRadius: 10, padding: 10, minWidth: 220,
                  zIndex: 151, boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                }}>
                  {isCommissioner && (
                    <div style={{ fontSize: 11, color: "#86efac", fontWeight: 700, marginBottom: 8 }}>
                      Commissioner
                    </div>
                  )}
                  {memberId ? (
                    <div style={{ fontSize: 11, color: theme.dim, marginBottom: 10 }}>
                      Signed in as {accountDisplayName}
                    </div>
                  ) : (
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 11, color: theme.dim, marginBottom: 6 }}>
                        Which of these are you?
                      </div>
                      {claimError && (
                        <div style={{ fontSize: 10, color: "#fca5a5", marginBottom: 6 }}>
                          {claimError}
                        </div>
                      )}
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" }}>
                        {unclaimedMembers.map((m) => (
                          <button key={m.id}
                            onClick={() => handleClaimMember(m.id)}
                            disabled={!!claimingId}
                            style={{
                              textAlign: "left",
                              background: "none", border: "1px solid " + theme.bdr,
                              borderRadius: 6, padding: "5px 8px",
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
                      borderRadius: 8, padding: "6px 10px",
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
              width: compact ? "100%" : "auto",
              background: "none",
              border: "1px solid " + theme.bdr,
              borderRadius: 8,
              padding: "6px 10px",
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
            position: "absolute", top: "100%", left: compact ? 0 : undefined, right: compact ? undefined : 0,
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
    display: "flex", alignItems: "center", gap: 10, width: "100%",
    padding: "10px 14px", borderRadius: 8, margin: "0 0 2px",
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
    <IconButton onClick={handlePushToggle}
      title={pushEnabled ? "Turn off notifications" : "Get notified about score updates"}
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
          gap: 8, padding: "10px 12px",
          background: theme.card, borderBottom: "1px solid " + theme.bdr,
          position: "sticky", top: "env(safe-area-inset-top, 0px)", zIndex: 100,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <Trophy size={20} color={theme.acc} style={{ flexShrink: 0 }} />
            <h1 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: "#FAFAFA",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Fantasy Life</h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {bellButton}
            {refreshButton}
            <AccountMenu compact />
            {settingsButton}
          </div>
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>

        <div style={{ padding: "12px 8px 72px" }}>{children}</div>

        {/* New bottom tab bar — doesn't exist today (the old layout was
            top-tab-bar-only on every screen size). Needs its own
            safe-area padding so it clears the home indicator on an
            installed-PWA iPhone, same reasoning as the header's own
            env(safe-area-inset-top) above. */}
        <nav aria-label="Main" style={{
          position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 100,
          display: "flex", background: theme.card, borderTop: "1px solid " + theme.bdr,
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}>
          {tabs.map((t) => {
            const isActive = activeTab === t.id;
            return (
              <button key={t.id} onClick={() => goToTab(t.id)}
                aria-current={isActive ? "page" : undefined}
                style={{
                  flex: 1, minHeight: 56, display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center", gap: 2,
                  background: "none", border: "none", font: "inherit",
                  color: isActive ? theme.acc : theme.dim,
                  fontSize: 10, fontWeight: isActive ? 700 : 500, cursor: "pointer",
                }}>
                <t.Icon size={18} />
                <span>{t.label}</span>
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
        width: 220, flexShrink: 0, padding: "20px 10px",
        position: "sticky", top: "env(safe-area-inset-top, 0px)",
        maxHeight: "100vh", overflowY: "auto",
        display: "flex", flexDirection: "column", gap: 4,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 4px 16px", fontSize: 18, fontWeight: 800, color: "#FAFAFA" }}>
          <Trophy size={24} color={theme.acc} style={{ flexShrink: 0 }} />
          Fantasy Life
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 4px 16px", minWidth: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}><AccountMenu /></div>
          {bellButton}
          {refreshButton}
          {settingsButton}
        </div>
        <nav aria-label="Main" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
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

      <div style={{ flex: 1, minWidth: 0, padding: "20px 16px" }}>
        {children}
      </div>
    </div>
  );
}
