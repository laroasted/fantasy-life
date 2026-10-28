import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Trophy,
  BarChart3,
  TrendingUp,
  Calendar as CalendarIcon,
  ClipboardList,
  Target,
  Settings as SettingsIcon,
} from "lucide-react";
import { theme } from "./constants/theme";
import { build2025 } from "./data";
import { withTimeout } from "./utils/helpers";
import {
  supabase,
  storageGet,
  storageSet,
  STORAGE_KEYS,
  fetchSeasonFromSupabase,
  saveLocksToSupabase,
  savePaywallsToSupabase,
  unlockPaywallRpc,
  signInWithGoogle,
  signOutCommissioner,
  getCommissionerSession,
  getConfiguredCommissionerEmails,
} from "./utils/storage";
import Scoreboard from "./components/Scoreboard";
import DraftTool from "./components/DraftTool";
import SeasonSettings from "./components/SeasonSettings";
import Calendar from "./components/Calendar";
import DraftRecap from "./components/DraftRecap";
import Trends from "./components/Trends";
import PrivacyPolicy from "./components/PrivacyPolicy";
import AdUnit from "./components/AdUnit";
import ScrollFadeEdges from "./components/ScrollFadeEdges";
import {
  track,
  EVENTS,
  identifyCommissioner,
  resetIdentity,
  setDeviceTypeSuperProperty,
  setSeasonSuperProperties,
} from "./utils/analytics";

const TABS = [
  { id: "scoreboard", label: "Scoreboard", Icon: BarChart3 },
  { id: "trends",     label: "Trends",     Icon: TrendingUp },
  { id: "calendar",   label: "Calendar",   Icon: CalendarIcon },
  { id: "recap",      label: "Recap",      Icon: ClipboardList },
  { id: "draft",      label: "Draft",      Icon: Target },
  { id: "settings",   label: "Settings",   Icon: SettingsIcon },
];
const TAB_IDS = TABS.map(function (t) { return t.id; }).concat(["privacy"]);

// Lets a link like "?tab=draft" land directly on that tab instead of
// always opening to Scoreboard, so a tab is actually shareable.
function tabFromUrl() {
  var params = new URLSearchParams(window.location.search);
  var fromUrl = params.get("tab");
  return TAB_IDS.includes(fromUrl) ? fromUrl : "scoreboard";
}

export default function App() {
  const [activeTab, setActiveTab] = useState(tabFromUrl);
  const [activeSeason, setActiveSeason] = useState(null);
  const [archivedSeasons, setArchivedSeasons] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [dataSource, setDataSource] = useState("loading");
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640);
  const [authReady, setAuthReady] = useState(false);
  const [commissionerSession, setCommissionerSession] = useState(null);
  const [commissionerRole, setCommissionerRole] = useState(null);
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
 
  const configuredCommissioners = getConfiguredCommissionerEmails();
  const isCommissioner = commissionerRole === "commissioner" || commissionerRole === "admin";
 
  // Track viewport width
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => { setDeviceTypeSuperProperty(isMobile); }, [isMobile]);

  // Keep the URL in sync with the active tab so a tab is a link someone can
  // actually send to the group chat, not just an in-session click target.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (activeTab === "scoreboard") params.delete("tab");
    else params.set("tab", activeTab);
    const search = params.toString();
    const newUrl = window.location.pathname + (search ? "?" + search : "") + window.location.hash;
    window.history.replaceState(null, "", newUrl);
  }, [activeTab]);

  const tabBarRef = useRef(null);

  useEffect(() => {
    let isMounted = true;
 
    async function loadAuth() {
      try {
        // Same Supabase-hang risk as loadSeason() — a session check that
        // never settles must not leave authReady stuck false forever.
        const result = await withTimeout(getCommissionerSession(), 10000, null);
        if (!result) throw new Error("getCommissionerSession timed out");
        const { session, role } = result;
        if (!isMounted) return;
        setCommissionerSession(session);
        setCommissionerRole(role);
      } catch (e) {
        // A stale/corrupted stored session can make getSession() throw
        // outright rather than return { error }. Resetting React state alone
        // isn't enough here — the broken token is still sitting in
        // localStorage and supabase-js will keep trying (and failing) to use
        // it on every future load, so this looks like a permanent lockout
        // even though the UI "recovers." Purge it locally (no network
        // round-trip needed — it's already broken) so the next load starts
        // clean and a fresh sign-in actually sticks.
        console.error("loadAuth failed, clearing local session:", e);
        try { await supabase.auth.signOut({ scope: "local" }); } catch (e2) {}
        if (!isMounted) return;
        setCommissionerSession(null);
        setCommissionerRole(null);
      } finally {
        if (isMounted) setAuthReady(true);
      }
    }

    loadAuth();

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!isMounted) return;
      setCommissionerSession(session || null);
      if (!session) {
        setCommissionerRole(null);
        setAuthReady(true);
        return;
      }
      try {
        const result = await withTimeout(getCommissionerSession(), 10000, null);
        if (!result) throw new Error("getCommissionerSession timed out");
        const { role } = result;
        if (!isMounted) return;
        setCommissionerRole(role);
      } catch (e) {
        console.error("Auth state change role lookup failed, clearing local session:", e);
        try { await supabase.auth.signOut({ scope: "local" }); } catch (e2) {}
        if (!isMounted) return;
        setCommissionerRole(null);
      } finally {
        if (isMounted) setAuthReady(true);
      }
    });
 
    return () => {
      isMounted = false;
      listener?.subscription?.unsubscribe();
    };
  }, []);

  // Fire Commissioner Signed In / Signed Out exactly once per real transition,
  // not on every re-render or on the initial unauthenticated state.
  const prevSignedInRef = useRef(false);
  useEffect(() => {
    if (!authReady) return;
    const signedIn = commissionerRole === "commissioner" || commissionerRole === "admin";
    if (signedIn && !prevSignedInRef.current) {
      const userId = commissionerSession?.user?.id;
      const email = commissionerSession?.user?.email;
      identifyCommissioner(userId, email, commissionerRole);
      track(EVENTS.COMMISSIONER_SIGNED_IN, { role: commissionerRole });
    } else if (!signedIn && prevSignedInRef.current) {
      track(EVENTS.COMMISSIONER_SIGNED_OUT);
      resetIdentity();
    }
    prevSignedInRef.current = signedIn;
  }, [authReady, commissionerRole, commissionerSession]);
 
  const lastSourceRef = useRef(null);
  const loadSeason = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true);
    // 10s timeout: a signed-in Supabase client can internally hang while
    // resolving the session before firing this request (SDK quirk) — fall
    // back exactly like an outright failure rather than spinning forever.
    let active = await withTimeout(fetchSeasonFromSupabase(), 10000, null);
    let source = "supabase";
    if (!active) {
      console.warn("Supabase fetch failed, trying localStorage...");
      try {
        const r = await storageGet(STORAGE_KEYS.ACTIVE_SEASON);
        if (r && r.value) { active = JSON.parse(r.value); source = "local"; }
      } catch (e) { console.error("Failed to load from localStorage:", e); }
      track(EVENTS.DATA_FALLBACK_USED, {
        surface: "season",
        fallback_level: source === "local" ? "local" : "hardcoded",
        reason: "supabase_fetch_failed",
      });
    }
    if (!active) { console.warn("No stored data, using hardcoded build2025()..."); active = build2025(); source = "hardcoded"; }
    setActiveSeason(active);
    setDataSource(source);
    setLastUpdated(new Date());
    setSeasonSuperProperties({ year: active?.year, dataSource: source });
    track(EVENTS.SEASON_LOADED, { data_source: source, year: active?.year, is_refresh: showRefreshing });
    lastSourceRef.current = source;
    if (showRefreshing) setRefreshing(false);
    return active;
  }, []);
 
  useEffect(() => {
    (async () => {
      await loadSeason();
      let archived = [];
      try {
        // Same hang risk as loadSeason() above — same 10s safety net.
        const archivedResult = await withTimeout(
          supabase.from('seasons').select('year').eq('status', 'archived').order('year', { ascending: false }),
          10000,
          { data: null }
        );
        const archivedMeta = archivedResult.data;
        if (archivedMeta && archivedMeta.length > 0) {
          const fullSeasons = await Promise.all(
            archivedMeta.map(s => withTimeout(fetchSeasonFromSupabase(s.year), 10000, null))
          );
          archived = fullSeasons.filter(Boolean);
        }
      } catch (e) { console.error("Failed to load archived seasons:", e); }
      setArchivedSeasons(archived);
      setLoaded(true);
      track(EVENTS.APP_LOADED, {
        data_source: lastSourceRef.current,
        is_mobile: window.innerWidth < 640,
        archived_season_count: archived.length,
      });
    })();
  }, [loadSeason]);
 
  // The lightweight loadSeason(true) refetch below only re-reads whatever
  // is already in Supabase — it doesn't recompute anything. Hitting
  // /api/refresh-all first runs every data-updating cron job on demand
  // (and snapshot-scores after them), so Refresh actually pulls fresh
  // numbers instead of just re-displaying the same ones. Best-effort: if
  // that call fails outright (network hiccup, a cold function timing out),
  // still fall through to the plain refetch rather than leaving the button
  // stuck or the page showing nothing new.
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    const startedAt = Date.now();
    let jobsSucceeded = 0, jobsFailed = 0, success = false;
    try {
      const res = await fetch("/api/refresh-all", { method: "POST" });
      const body = await res.json().catch(() => null);
      const jobs = (body && body.jobs) || [];
      jobsSucceeded = jobs.filter((j) => j.ok).length;
      jobsFailed = jobs.length - jobsSucceeded;
      success = !!(body && body.success);
    } catch (e) {
      console.warn("Full refresh (crons) failed, falling back to a plain data refetch:", e);
    }
    track(EVENTS.DATA_REFRESH_TRIGGERED, {
      success, jobs_succeeded: jobsSucceeded, jobs_failed: jobsFailed, duration_ms: Date.now() - startedAt,
    });
    await loadSeason(true);
  }, [loadSeason]);
 
  const handleFinalize = useCallback(async (newSeason) => {
    const newArchived = [activeSeason, ...archivedSeasons].filter(Boolean);
    setArchivedSeasons(newArchived);
    setActiveSeason(newSeason);
    // Without this, selectedYear keeps pointing at the season that just
    // got archived — isViewingActive would read false and the commissioner
    // would land back on the season they just finalized out of, not the
    // new one.
    setSelectedYear(newSeason.year);
    try { await storageSet(STORAGE_KEYS.ACTIVE_SEASON, JSON.stringify(newSeason)); } catch (e) {}
    try { await storageSet(STORAGE_KEYS.ARCHIVED_SEASONS, JSON.stringify(newArchived)); } catch (e) {}
    setActiveTab("scoreboard");
  }, [activeSeason, archivedSeasons]);
 
  const handleSettingsSave = useCallback(async (updatedSeason) => {
    if (!isCommissioner) {
      throw new Error("Commissioner access required to save season settings.");
    }
    setActiveSeason(updatedSeason);
    try { await storageSet(STORAGE_KEYS.ACTIVE_SEASON, JSON.stringify(updatedSeason)); } catch (e) {}
    if (updatedSeason.locks && updatedSeason.year) {
      await saveLocksToSupabase(updatedSeason.year, updatedSeason.locks);
    }
    if (updatedSeason.paywalls && updatedSeason.year) {
      await savePaywallsToSupabase(updatedSeason.year, updatedSeason.paywalls);
    }
  }, [isCommissioner]);

  // No commissioner gate here on purpose: any visitor who pays their own
  // toll can lift their own paywall. The actual write goes through a
  // security-definer RPC (see supabase/phase3_paywalls.sql) that can only
  // flip that one member's `enabled` flag — nothing else is writable by
  // an anonymous visitor.
  //
  // The RPC is awaited and checked before the UI (or localStorage) ever
  // claims success: the PayPal charge already happened by the time this
  // runs, but if the backend write fails (migration not applied yet, a
  // transient network/RLS error), a reload must NOT silently re-lock
  // someone who already paid without them being told. Returns true only
  // once the unlock is actually persisted.
  const handlePaywallUnlock = useCallback(async (memberId) => {
    if (!memberId || !activeSeason?.year) return false;
    const ok = await unlockPaywallRpc(activeSeason.year, memberId);
    if (!ok) return false;
    setActiveSeason((prev) => {
      if (!prev) return prev;
      const updated = JSON.parse(JSON.stringify(prev));
      if (!updated.paywalls) updated.paywalls = {};
      updated.paywalls[memberId] = Object.assign({}, updated.paywalls[memberId], { enabled: false });
      storageSet(STORAGE_KEYS.ACTIVE_SEASON, JSON.stringify(updated)).catch(() => {});
      return updated;
    });
    return true;
  }, [activeSeason]);
 
  const handleGoogleSignIn = useCallback(async () => {
    setAuthLoading(true);
    setAuthError("");
    track(EVENTS.COMMISSIONER_LOGIN_SUBMITTED);
    const result = await signInWithGoogle();
    if (!result.ok) {
      setAuthError(result.error);
      track(EVENTS.COMMISSIONER_LOGIN_FAILED, { error_message: result.error });
      setAuthLoading(false);
    }
    // On success, signInWithOAuth triggers a full-page redirect to Google's
    // consent screen, so there's nothing further to do here — authLoading
    // intentionally stays true until the page navigates away.
  }, []);

  const handleCommissionerSignOut = useCallback(async () => {
    setAuthLoading(true);
    setAuthError("");
    const result = await signOutCommissioner();
    if (!result.ok) setAuthError(result.error || "Unable to sign out.");
    setAuthLoading(false);
  }, []);

  // ── Season/year picker ──
  // Scoreboard, Trends, Calendar, and Recap can all show any season on
  // record, not just whichever one is currently active — Settings stays
  // tied to the active season always (editing history is a separate,
  // riskier feature nobody asked for yet).
  const [selectedYear, setSelectedYear] = useState(null);

  // Defaults to the active season on first load; a shared "?year=2025"
  // link overrides that default so a specific season view is linkable.
  useEffect(() => {
    if (selectedYear !== null || !activeSeason) return;
    const params = new URLSearchParams(window.location.search);
    const fromUrl = parseInt(params.get("year"), 10);
    setSelectedYear(!isNaN(fromUrl) ? fromUrl : activeSeason.year);
  }, [activeSeason, selectedYear]);

  useEffect(() => {
    if (selectedYear === null || !activeSeason) return;
    const params = new URLSearchParams(window.location.search);
    if (selectedYear === activeSeason.year) params.delete("year");
    else params.set("year", String(selectedYear));
    const search = params.toString();
    const newUrl = window.location.pathname + (search ? "?" + search : "") + window.location.hash;
    window.history.replaceState(null, "", newUrl);
  }, [selectedYear, activeSeason]);

  const availableSeasons = useMemo(() => {
    if (!activeSeason) return [];
    const list = [{ year: activeSeason.year, isActive: true }];
    archivedSeasons.forEach((s) => { if (s && s.year) list.push({ year: s.year, isActive: false }); });
    return list.sort((a, b) => b.year - a.year);
  }, [activeSeason, archivedSeasons]);

  // Correct a selected year that isn't a real season — a stale/typo'd
  // "?year=" link, most likely — back to the active season. This can't run
  // in the same effect that reads the URL, or gate on availableSeasons
  // merely being non-empty: it gets an entry for the active season the
  // instant activeSeason loads, while archivedSeasons is fetched in a
  // separate, later step of the mount effect. Gating on `loaded` instead —
  // which only flips true once both fetches have settled — is what
  // actually waits long enough for a legitimate archived-year deep link
  // not to be misjudged as invalid and reset before archivedSeasons has
  // had a chance to arrive.
  useEffect(() => {
    if (!loaded || selectedYear === null || !activeSeason) return;
    if (!availableSeasons.some((s) => s.year === selectedYear)) setSelectedYear(activeSeason.year);
  }, [loaded, availableSeasons, selectedYear, activeSeason]);

  const isViewingActive = !activeSeason || selectedYear === null || selectedYear === activeSeason.year;

  // The full season object for whatever year is selected — used by
  // Scoreboard and Trends, which both need more than just the year number.
  const viewingSeasonData = useMemo(() => {
    if (!activeSeason) return null;
    if (isViewingActive) return activeSeason;
    return archivedSeasons.find((s) => s && s.year === selectedYear) || activeSeason;
  }, [activeSeason, archivedSeasons, selectedYear, isViewingActive]);

  if (!loaded) {
    return (
      <div style={{ background: theme.bg, minHeight: "100vh", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", color: theme.dim, fontFamily: "system-ui", gap: 12 }}>
        <Trophy size={32} color={theme.acc} />
        <div style={{ fontSize: 16, fontWeight: 600 }}>Loading scores...</div>
        <div style={{ width: 120, height: 3, borderRadius: 2, background: theme.card, overflow: "hidden" }}>
          <div style={{ width: "40%", height: "100%", borderRadius: 2, background: theme.acc,
            animation: "pulse 1.5s ease-in-out infinite" }} />
        </div>
        <style>{`@keyframes pulse { 0%,100% { opacity: 0.4; transform: translateX(-20px); } 50% { opacity: 1; transform: translateX(80px); } }`}</style>
      </div>
    );
  }
 
  var draftDateStr = viewingSeasonData && viewingSeasonData.draftDate
    ? new Date(viewingSeasonData.draftDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "date not set";
  var viewingYear = selectedYear !== null ? selectedYear : (activeSeason && activeSeason.year) || new Date().getFullYear();

  return (
    <div style={{ background: theme.bg, minHeight: "100vh", color: theme.txt,
      fontFamily: "Inter, system-ui, sans-serif" }}>
      {/* ── Header + Tabs ── */}
      <div style={{
        background: theme.card,
        borderBottom: "1px solid " + theme.bdr,
        padding: isMobile ? "12px 12px 0" : "16px 20px 0",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          {/* Title row */}
          <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12,
            marginBottom: isMobile ? 10 : 16 }}>
            <Trophy size={isMobile ? 22 : 28} color={theme.acc} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 style={{
                fontSize: isMobile ? 18 : 22, fontWeight: 800, margin: 0, color: "#FAFAFA",
              }}>Fantasy Life</h1>
            </div>
            {/* Commissioner auth only matters on Draft/Settings — keeping it off the
                header on every other tab gives the primary surfaces (Scoreboard
                especially) back the width this was eating on mobile. */}
            {authReady && (activeTab === "draft" || activeTab === "settings") && (
              <div style={{
                display: "flex",
                flexDirection: "column",
                alignItems: isMobile ? "stretch" : "flex-end",
                gap: 6,
                minWidth: isMobile ? 0 : 280,
              }}>
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                  justifyContent: isMobile ? "flex-start" : "flex-end",
                }}>
                  {isCommissioner ? (
                    <>
                      <span style={{ fontSize: 11, color: "#86efac", fontWeight: 700 }}>
                        Commissioner signed in
                      </span>
                      <button
                        onClick={handleCommissionerSignOut}
                        disabled={authLoading}
                        style={{
                          background: "none",
                          border: "1px solid " + theme.bdr,
                          borderRadius: 8,
                          padding: isMobile ? "5px 8px" : "6px 10px",
                          color: theme.txt,
                          fontSize: 11,
                          cursor: authLoading ? "default" : "pointer",
                        }}>
                        Sign out
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => { setAuthError(""); handleGoogleSignIn(); }}
                      disabled={authLoading}
                      style={{
                        background: "none",
                        border: "1px solid " + theme.bdr,
                        borderRadius: 8,
                        padding: isMobile ? "5px 8px" : "6px 10px",
                        color: theme.txt,
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: authLoading ? "default" : "pointer",
                        opacity: authLoading ? 0.6 : 1,
                      }}>
                      {authLoading ? "Redirecting…" : "Sign in with Google"}
                    </button>
                  )}
                </div>
                {authError && (
                  <div style={{ fontSize: 10, color: "#fca5a5", textAlign: isMobile ? "left" : "right" }}>
                    {authError}
                  </div>
                )}
              </div>
            )}
            {/* Elsewhere, a signed-in commissioner gets a quiet reminder instead of
                losing all trace that they're signed in. */}
            {authReady && !(activeTab === "draft" || activeTab === "settings") && isCommissioner && (
              <span style={{ fontSize: 11, color: "#86efac", fontWeight: 700, flexShrink: 0 }}>
                Commissioner
              </span>
            )}
            <button onClick={handleRefresh} disabled={refreshing}
              style={{
                background: "none", border: "1px solid " + theme.bdr, borderRadius: 8,
                padding: isMobile ? "5px 8px" : "6px 12px",
                color: refreshing ? theme.dim : theme.mut,
                fontSize: isMobile ? 11 : 12, cursor: refreshing ? "default" : "pointer",
                display: "flex", alignItems: "center", gap: 4,
                opacity: refreshing ? 0.6 : 1, transition: "opacity 0.2s",
                flexShrink: 0,
              }}>
              <span style={{ display: "inline-block",
                animation: refreshing ? "spin 1s linear infinite" : "none" }}>↻</span>
              {!isMobile && (refreshing ? "Refreshing..." : "Refresh")}
            </button>
            <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
          </div>
 
          {/* Tab bar */}
          <ScrollFadeEdges scrollRef={tabBarRef} fadeColor={theme.card}>
          <div ref={tabBarRef} style={{
            display: "flex", gap: 0,
            overflowX: isMobile ? "auto" : "visible",
            WebkitOverflowScrolling: "touch",
            msOverflowStyle: "none", scrollbarWidth: "none",
          }}>
            {TABS.map(function (t) {
              var isActive = activeTab === t.id;
              return (
                <button key={t.id} onClick={function () {
                    track(EVENTS.TAB_VIEWED, { tab_name: t.id, previous_tab: activeTab, is_mobile: isMobile });
                    setActiveTab(t.id);
                  }}
                  style={{
                    flex: isMobile ? "0 0 auto" : "unset",
                    display: "flex", alignItems: "center", gap: 6,
                    padding: isMobile ? "8px 10px" : "10px 20px",
                    background: "none", border: "none",
                    borderBottom: isActive ? "2px solid " + theme.acc : "2px solid transparent",
                    color: isActive ? theme.acc : theme.dim,
                    fontSize: isMobile ? 11 : 13,
                    fontWeight: isActive ? 700 : 500,
                    cursor: "pointer", whiteSpace: "nowrap",
                  }}>
                  <t.Icon size={isMobile ? 14 : 15} />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>
          </ScrollFadeEdges>
        </div>
      </div>

      {/* ── Tab Content ── */}
      <div style={{ padding: isMobile ? "12px 8px" : "20px 16px" }}>
        {["scoreboard", "trends", "calendar", "recap"].includes(activeTab) && availableSeasons.length > 1 && (
          <div style={{ maxWidth: 760, margin: "0 auto 14px", display: "flex", alignItems: "center",
            justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
            <select value={viewingYear}
              onChange={(e) => setSelectedYear(parseInt(e.target.value, 10))}
              style={{ background: theme.card, border: "1px solid " + theme.bdr, borderRadius: 8,
                padding: "6px 10px", color: theme.txt, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              {availableSeasons.map((s) => (
                <option key={s.year} value={s.year}>{s.year}{s.isActive ? " (current)" : ""}</option>
              ))}
            </select>
            {!isViewingActive && (
              <button onClick={() => setSelectedYear(activeSeason.year)}
                style={{ background: "none", border: "none", color: theme.acc, cursor: "pointer",
                  fontSize: 11, fontWeight: 700, textDecoration: "underline", padding: 0 }}>
                Back to current season
              </button>
            )}
          </div>
        )}
        {activeTab === "scoreboard" && (
          <div>
            <div style={{ textAlign: "center", marginBottom: 20, maxWidth: 760, margin: "0 auto 20px" }}>
              <p style={{ fontSize: isMobile ? 11 : 12, color: theme.dim, margin: 0 }}>
                {draftDateStr} through {viewingYear + 1} Academy Awards
              </p>
              {lastUpdated && isViewingActive && (
                <p style={{ fontSize: 10, color: theme.dim, margin: "4px 0 0", opacity: 0.6,
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
                  <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                    background: dataSource === "supabase" ? theme.grn : dataSource === "local" ? theme.yel : theme.red }} />
                  {dataSource === "supabase" ? "Live" : dataSource === "local" ? "Cached" : "Offline"}
                  {" "}· Updated {lastUpdated.toLocaleTimeString()}
                </p>
              )}
            </div>
            <Scoreboard seasonData={viewingSeasonData} onUnlockPaywall={isViewingActive ? handlePaywallUnlock : undefined} />
            <div style={{ maxWidth: 760, margin: "20px auto 0" }}>
              <AdUnit slot="9806940854" />
            </div>
          </div>
        )}
        {activeTab === "trends" && (
          <Trends seasonData={viewingSeasonData} />
        )}
        {activeTab === "calendar" && (
          <Calendar seasonYear={viewingYear} />
        )}
        {activeTab === "recap" && (
          <DraftRecap seasonYear={viewingYear} />
        )}
        {activeTab === "draft" && (
          <DraftTool
            onFinalize={handleFinalize}
            isCommissioner={isCommissioner}
            commissionerEmail={commissionerSession?.user?.email || ""}
          />
        )}
        {activeTab === "settings" && (
          <SeasonSettings
            seasonData={activeSeason}
            onSave={handleSettingsSave}
            isCommissioner={isCommissioner}
            commissionerEmail={commissionerSession?.user?.email || ""}
          />
        )}
        {activeTab === "privacy" && <PrivacyPolicy />}
      </div>

      {/* ── Footer ── */}
      <div style={{ textAlign: "center", padding: "16px 8px 24px" }}>
        <button
          onClick={() => setActiveTab("privacy")}
          style={{
            background: "none", border: "none", color: theme.mut,
            fontSize: 11, cursor: "pointer", textDecoration: "underline",
          }}>
          Privacy Policy
        </button>
      </div>
    </div>
  );
}
