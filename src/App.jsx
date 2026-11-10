import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense, Component } from "react";
import {
  Trophy,
  BarChart3,
  TrendingUp,
  TrendingDown,
  Calendar as CalendarIcon,
  ClipboardList,
  Target,
  Settings as SettingsIcon,
  Bell,
  BellOff,
} from "lucide-react";
import { theme } from "./constants/theme";
import { build2025 } from "./data";
import { withTimeout } from "./utils/helpers";
import { useViewport } from "./utils/useViewport";
import {
  supabase,
  supabasePublic,
  storageSet,
  STORAGE_KEYS,
  fetchSeasonFromSupabase,
  fetchProjectionsFromSupabase,
  cacheActiveSeason,
  readCachedActiveSeason,
  fetchBiggestScoreMovers,
  saveLocksToSupabase,
  savePaywallsToSupabase,
  unlockPaywallRpc,
  signInWithGoogle,
  signOutCommissioner,
  getCommissionerRole,
  getConfiguredCommissionerEmails,
  claimMemberIdentityRpc,
  autoClaimMemberIdentityRpc,
  fetchClaimedMemberIds,
  SUPABASE_SESSION_STORAGE_KEY,
} from "./utils/storage";
import { DRAFT_MEMBERS, MEMBER_COLORS } from "./constants/members";
import Scoreboard from "./components/Scoreboard";
import AdUnit from "./components/AdUnit";
import ScrollFadeEdges from "./components/ScrollFadeEdges";
import { Skeleton } from "./components/Badges";

// Scoreboard (above) is the default tab and the one every link/share
// lands on, so it stays an eager import — everything below only costs a
// visitor anything the moment they actually click that tab. These six
// cover every non-Scoreboard destination in App.jsx's TABS array plus
// Settings/Privacy, which aren't in TABS but are still reachable.
const DraftTool = lazy(() => import("./components/DraftTool"));
const SeasonSettings = lazy(() => import("./components/SeasonSettings"));
const Calendar = lazy(() => import("./components/Calendar"));
const DraftRecap = lazy(() => import("./components/DraftRecap"));
const Trends = lazy(() => import("./components/Trends"));
const PrivacyPolicy = lazy(() => import("./components/PrivacyPolicy"));
import {
  track,
  EVENTS,
  identifyPerson,
  markCommissionerLogin,
  resetIdentity,
  setDeviceTypeSuperProperty,
  setSeasonSuperProperties,
} from "./utils/analytics";
import {
  isPushSupported,
  getExistingPushSubscription,
  subscribeToPush,
  unsubscribeFromPush,
} from "./utils/push";

const TABS = [
  { id: "scoreboard", label: "Scoreboard", Icon: BarChart3 },
  { id: "trends",     label: "Trends",     Icon: TrendingUp },
  { id: "calendar",   label: "Calendar",   Icon: CalendarIcon },
  { id: "recap",      label: "Recap",      Icon: ClipboardList },
  { id: "draft",      label: "Draft",      Icon: Target },
];
// Settings lives behind the header gear icon, not the tab bar — it's the
// only fully sign-in-gated surface, unlike Draft which works (just doesn't
// save) without a commissioner session. "settings" stays a valid activeTab
// and a valid ?tab= value even though it's no longer in TABS.
const TAB_IDS = TABS.map(function (t) { return t.id; }).concat(["privacy", "settings"]);

// Lets a link like "?tab=draft" land directly on that tab instead of
// always opening to Scoreboard, so a tab is actually shareable.
// Suspense fallback while a lazy-loaded tab's chunk downloads — distinct
// from (and much shorter-lived than) that tab's own internal data-loading
// skeleton, which only shows once the component itself has mounted.
function TabFallback() {
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 10 }}>
      <Skeleton height={16} width="35%" />
      <Skeleton height={70} radius={12} />
      <Skeleton height={70} radius={12} />
    </div>
  );
}

// Catches a lazy tab chunk failing to load (transient network/CDN blip, or
// a stale client holding a chunk hash a new deploy no longer serves).
// Suspense alone only covers the *pending* state — a rejected dynamic
// import throws, and without a boundary that escapes all the way past
// this component, taking the eagerly-mounted Scoreboard/header down with
// it instead of just the one optional tab. Resets automatically on the
// next tab switch because it lives inside the activeTab-keyed div below,
// which remounts it.
class TabErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    console.error("Tab failed to load:", error);
  }
  render() {
    if (this.state.failed) {
      return (
        <div style={{ textAlign: "center", padding: 40, color: theme.dim }}>
          <div style={{ marginBottom: 12, fontSize: 14 }}>
            This tab couldn't load — probably a network blip.
          </div>
          <button onClick={() => window.location.reload()}
            style={{ background: "none", border: "1px solid " + theme.bdr, borderRadius: 8,
              padding: "7px 16px", color: theme.txt, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function tabFromUrl() {
  var params = new URLSearchParams(window.location.search);
  var fromUrl = params.get("tab");
  return TAB_IDS.includes(fromUrl) ? fromUrl : "scoreboard";
}

// "Sun" for an event landing this week, "Nov 15" for anything further out —
// same <=6-day "this week" window Calendar.jsx uses for its "now" status.
function fmtEventWhen(dateStr) {
  var parts = dateStr.split("-").map(Number);
  var date = new Date(parts[0], parts[1] - 1, parts[2]);
  var now = new Date();
  now.setHours(0, 0, 0, 0);
  var diffDays = Math.round((date - now) / 86400000);
  return diffDays <= 6
    ? date.toLocaleDateString("en-US", { weekday: "short" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Optimistic auth hydration ──
//
// supabase-js's own getSession() is lock-gated (see GoTrueClient
// _acquireLock, and storage.js's SUPABASE_SESSION_STORAGE_KEY comment) —
// reported live as a 10+ second wait after a refresh before the account
// menu shows anyone as signed in at all, even though the session is
// sitting right there in localStorage the whole time. Nothing about
// *reading* that key needs the lock: the lock exists to serialize writes
// and refreshes, not to protect a plain read of what's already stored.
//
// So on mount, before any of that async machinery even starts, read the
// persisted session directly and — if it looks unexpired — use it to paint
// the signed-in UI immediately. This is optimistic, not authoritative: the
// real loadAuth()/onAuthStateChange flow below still runs exactly as
// before and overwrites these values (session, role, memberId) with the
// confirmed ones once it resolves, correcting anything this guessed wrong.
// Worst case on a stale/invalid stored token is a few seconds of showing
// the wrong person before that correction lands — a strict improvement
// over several seconds of showing no one.
//
// commissionerRole/memberId aren't in that localStorage blob at all (they
// come from our own `profiles` lookup, which — being an authenticated
// query — is itself lock-gated and can't be shortcut the same way), so
// those are optimistically restored from a small cache this file writes
// itself, in writeCachedIdentity() below, every time the real flow
// resolves them. Both reads are skipped (and the identity cache stays
// unused) whenever there's no plausible session — a genuinely signed-out
// visitor gets an instant, confident "not signed in" render instead of
// waiting it out just to be told what localStorage already shows.
const CACHED_IDENTITY_KEY = "fl-cached-identity";

function readOptimisticSession() {
  try {
    var raw = window.localStorage.getItem(SUPABASE_SESSION_STORAGE_KEY);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    if (!parsed || !parsed.access_token || !parsed.user) return null;
    if (parsed.expires_at && parsed.expires_at * 1000 < Date.now()) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function readCachedIdentity() {
  try {
    var raw = window.localStorage.getItem(CACHED_IDENTITY_KEY);
    if (!raw) return { role: null, memberId: null };
    var parsed = JSON.parse(raw);
    return { role: (parsed && parsed.role) || null, memberId: (parsed && parsed.memberId) || null };
  } catch (e) {
    return { role: null, memberId: null };
  }
}

function writeCachedIdentity(role, memberId) {
  try {
    if (!role && !memberId) { window.localStorage.removeItem(CACHED_IDENTITY_KEY); return; }
    window.localStorage.setItem(CACHED_IDENTITY_KEY, JSON.stringify({ role: role, memberId: memberId }));
  } catch (e) {}
}

function clearCachedIdentity() {
  try { window.localStorage.removeItem(CACHED_IDENTITY_KEY); } catch (e) {}
}

export default function App() {
  const [activeTab, setActiveTab] = useState(tabFromUrl);
  // Instant paint from whatever this device last saw, same reasoning as
  // "Optimistic auth hydration" below: the real loadSeason() fetch in the
  // mount effect further down still always runs and overwrites every one
  // of these the moment it resolves (dataSource flips "local" →
  // "supabase", lastUpdated to "just now") — this is purely a perceived-
  // speed head start on a repeat visit, never a substitute for the real
  // fetch. A first-ever visit on this device has nothing to seed from
  // and falls straight through to the loading spinner exactly as before.
  const [activeSeason, setActiveSeason] = useState(() => {
    const cached = readCachedActiveSeason();
    return cached ? cached.season : null;
  });
  const [archivedSeasons, setArchivedSeasons] = useState([]);
  // Separate from `loaded` on purpose: `loaded` now flips as soon as the
  // active season alone is in hand (it no longer waits on archived
  // seasons — see the mount effect below), including instantly from
  // cache before any fetch has even started. The year-validation effect
  // further down still needs a signal that specifically means "archived
  // seasons has actually resolved," or it misjudges a legitimate
  // archived-year deep link as invalid before archivedSeasons has had a
  // chance to arrive and resets it to the active season.
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [loaded, setLoaded] = useState(() => !!readCachedActiveSeason());
  // Whether the very first loadSeason() call for this page load (the one
  // in the mount effect below) has resolved yet — true from mount,
  // flipped false once, success or failure, and never touched again by a
  // later manual refresh or realtime-triggered reload (those already have
  // their own `refreshing` spinner on the Refresh button). This is the
  // one genuine window where "more data is coming" is actually true: a
  // cache-seeded first render already has something to show, but the
  // real fetch behind it hasn't landed yet. See the status line render
  // below and its own comment for how this gets used.
  const [initialSyncPending, setInitialSyncPending] = useState(true);
  // Time-gated on purpose: most visits resolve this within a fraction of
  // a second, faster than a human reacts to anything — escalating the
  // status line's styling immediately would just be noise for the common
  // case. Only past this threshold does "still syncing" actually mean
  // something worth a louder signal.
  const [syncDelayPassed, setSyncDelayPassed] = useState(false);
  // Mirrors syncDelayPassed for the mount effect below to read — that
  // effect's own callback closes over this render's values once, at
  // mount, so the state variable itself would always read as its
  // initial `false` there regardless of how much real time has actually
  // passed by the time the fetch resolves. A ref sidesteps that; the
  // state above is still what drives the actual re-render.
  const syncDelayPassedRef = useRef(false);
  useEffect(() => {
    const id = setTimeout(() => {
      syncDelayPassedRef.current = true;
      setSyncDelayPassed(true);
    }, 1300);
    return () => clearTimeout(id);
  }, []);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(() => {
    const cached = readCachedActiveSeason();
    return cached && cached.cachedAt ? new Date(cached.cachedAt) : null;
  });
  const [dataSource, setDataSource] = useState(() => (readCachedActiveSeason() ? "local" : "loading"));
  // Shared with Scoreboard.jsx via useViewport() so the header widens in
  // lockstep with Scoreboard's sidebar instead of the two hand-copying the
  // same breakpoint numbers (see useViewport.js).
  const { isMobile, isWide } = useViewport();
  // See the "Optimistic auth hydration" comment above: these three start
  // from whatever's already in localStorage instead of null/false, so the
  // account menu has something to show on the very first render rather
  // than waiting out loadAuth()'s lock-gated session check. authReady
  // itself can start true unconditionally — "no session in localStorage"
  // is just as confident and instant an answer as "session found".
  // authConfirmed tracks the separate, still-async question of whether the
  // REAL check (below) has corrected/confirmed these yet; anything that
  // must not act on a guess (Mixpanel identity, login bookkeeping) gates
  // on that instead.
  const [authReady, setAuthReady] = useState(true);
  const [authConfirmed, setAuthConfirmed] = useState(false);
  const [commissionerSession, setCommissionerSession] = useState(readOptimisticSession);
  const [commissionerRole, setCommissionerRole] = useState(
    () => (readOptimisticSession() ? readCachedIdentity().role : null)
  );
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [memberId, setMemberId] = useState(
    () => (readOptimisticSession() ? readCachedIdentity().memberId : null)
  );
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [claimedMemberIds, setClaimedMemberIds] = useState([]);
  const [claimingId, setClaimingId] = useState(null);
  const [claimError, setClaimError] = useState("");
  const [biggestRiser, setBiggestRiser] = useState(null);
  const [biggestFaller, setBiggestFaller] = useState(null);
  const [nextEvent, setNextEvent] = useState(null);
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);

  useEffect(() => {
    if (!isPushSupported()) return;
    setPushSupported(true);
    getExistingPushSubscription().then((sub) => setPushEnabled(!!sub));
  }, []);

  const handlePushToggle = useCallback(async () => {
    if (pushEnabled) {
      await unsubscribeFromPush();
      setPushEnabled(false);
      track(EVENTS.PUSH_NOTIFICATIONS_TOGGLED, { is_enabled: false });
    } else {
      const result = await subscribeToPush(memberId);
      setPushEnabled(result.ok);
      track(EVENTS.PUSH_NOTIFICATIONS_TOGGLED, {
        is_enabled: result.ok,
        ...(!result.ok && { reason: result.reason }),
      });
    }
  }, [pushEnabled, memberId]);

  const configuredCommissioners = getConfiguredCommissionerEmails();
  const isCommissioner = commissionerRole === "commissioner" || commissionerRole === "admin";
  const accountDisplayName = memberId
    ? (DRAFT_MEMBERS.find((m) => m.id === memberId)?.name || memberId)
    : null;
  const unclaimedMembers = useMemo(
    () => DRAFT_MEMBERS.filter((m) => !claimedMemberIds.includes(m.id)),
    [claimedMemberIds]
  );

  useEffect(() => { setDeviceTypeSuperProperty(isMobile); }, [isMobile]);

  // Lazily fetch who's already claimed, only when the picker is actually
  // open and there's still a name to pick — no need to hold this in state
  // for visitors who never open the menu.
  useEffect(() => {
    if (!showAccountMenu || memberId || !commissionerSession) return;
    fetchClaimedMemberIds().then(setClaimedMemberIds).catch(() => setClaimedMemberIds([]));
  }, [showAccountMenu, memberId, commissionerSession]);

  const handleClaimMember = useCallback(async (id) => {
    setClaimingId(id);
    setClaimError("");
    const ok = await claimMemberIdentityRpc(id);
    if (ok) {
      setMemberId(id);
      writeCachedIdentity(commissionerRole, id);
      track(EVENTS.MEMBER_CLAIMED, { member_id: id, method: "manual" });
      setShowAccountMenu(false);
      // If push was already enabled from before this device had a claimed
      // identity, re-subscribe so the stored subscription picks up the
      // member_id — otherwise it stays null until they happen to retoggle
      // the bell, and this device quietly misses targeted pushes.
      // subscribeToPush() already fails silently on its own; nothing here
      // needs to react to the result.
      if (pushEnabled) subscribeToPush(id);
    } else {
      setClaimError("That name may already be claimed — try again or ask the commissioner.");
    }
    setClaimingId(null);
  }, [pushEnabled, commissionerRole]);

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
      // Only resolves the session object itself here, quickly, and handles
      // the one case that genuinely means "this stored session is
      // unusable": getSession() throwing outright on a corrupted/malformed
      // token. Role and member_id are deliberately NOT fetched here — that
      // used to happen in both this function AND the onAuthStateChange
      // listener's first firing, which fixed a real double-query
      // performance bug but introduced a worse one: when this function's
      // own fetch timed out, NOTHING ever retried role/memberId for that
      // load, leaving someone correctly shown as signed in (commissionerSession
      // set below) but with memberId stuck null — "logged in but the
      // highlight never shows" until a manual sign-out/in forced a fresh
      // attempt. Now there is exactly one place that ever fetches
      // role/memberId — the listener below, on every firing including its
      // reliable first one — so that fetch is never a single unretried
      // attempt with no fallback.
      let session;
      try {
        let sessionResult = await withTimeout(supabase.auth.getSession(), 10000, null);
        if (!sessionResult) {
          // One retry before giving up — same reasoning as the retry on
          // getCommissionerRole's own timeout further below: a single slow
          // lock acquisition must not be the only chance this gets. This
          // specific timeout is the one reported live as "signed in on
          // mobile, but some mornings the account menu shows signed-out
          // until I close and reopen the app" — the first open after being
          // backgrounded overnight is exactly when a cold connection is
          // most likely to blow one 10s window, and closing/reopening just
          // gives the same check a second, now-warmed-up attempt. Retrying
          // once in place gets that same second attempt without needing
          // the person to do it by hand.
          console.warn("loadAuth: getSession timed out — retrying once");
          sessionResult = await withTimeout(supabase.auth.getSession(), 10000, null);
        }
        if (!sessionResult) {
          // Timed out twice, not corrupted — leave stored session/role
          // state untouched, but still mark the initial check as done. This
          // used to skip setAuthReady here, relying entirely on the
          // onAuthStateChange listener below to set it once it fired —
          // reliable in every Chromium test this session ran, but NOT in
          // real-world Safari: confirmed live, a signed-in person's entire
          // account menu (sign-in button included) rendered as nothing at
          // all, because authReady never became true. withTimeout is a
          // plain setTimeout race, not dependent on anything Safari-specific
          // (unlike gotrue-js's own Web Locks usage elsewhere), so this is a
          // safe, guaranteed-to-fire path regardless of what the listener
          // does or how long it takes.
          console.warn("loadAuth: getSession timed out twice — leaving stored session untouched");
          if (isMounted) setAuthReady(true);
          return;
        }
        if (sessionResult.error) throw new Error(sessionResult.error.message || "getSession failed");
        session = sessionResult.data?.session || null;
      } catch (e) {
        console.error("loadAuth failed, clearing local session:", e);
        try { await supabase.auth.signOut({ scope: "local" }); } catch (e2) {}
        clearCachedIdentity();
        if (isMounted) {
          setCommissionerSession(null);
          setCommissionerRole(null);
          setMemberId(null);
          setAuthReady(true);
          setAuthConfirmed(true);
        }
        return;
      }

      if (!isMounted) return;
      setCommissionerSession(session);
      // Always set, not just for the anonymous case — authReady means "we
      // finished checking for a session," not "role/memberId also
      // resolved." The listener below still independently resolves those
      // whenever it fires, filling them in moments later if it's slower
      // than this — but the UI (the whole account menu, sign-in button
      // included) must never hang waiting on that just to render at all.
      setAuthReady(true);
    }

    loadAuth();

    // Fires once immediately on subscription, reliably, with whatever
    // session already exists — this is now the ONLY place that fetches
    // role/member_id, on every firing including this first one. (It used
    // to be skipped here to avoid double-querying profiles alongside
    // loadAuth's own now-removed role fetch — see that function's comment
    // for the gap that shortcut left.)
    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!isMounted) return;
      setCommissionerSession(session || null);

      if (!session) {
        clearCachedIdentity();
        setCommissionerRole(null);
        setMemberId(null);
        setAuthReady(true);
        setAuthConfirmed(true);
        return;
      }

      // Timing out and genuinely failing are NOT the same thing, and only
      // one of them means the stored session is actually bad — see
      // loadAuth's own comment on this distinction.
      let result;
      try {
        result = await withTimeout(getCommissionerRole(session), 10000, null);
      } catch (e) {
        console.error("Auth state change role lookup failed, clearing local session:", e);
        try { await supabase.auth.signOut({ scope: "local" }); } catch (e2) {}
        clearCachedIdentity();
        if (isMounted) {
          setCommissionerRole(null);
          setMemberId(null);
          setAuthReady(true);
          setAuthConfirmed(true);
        }
        return;
      }

      if (!result || result.errored) {
        // One retry before giving up — with nothing else in this app that
        // would ever come back and finish this lookup (the next thing to
        // fire this listener again could be the SDK's own token-refresh
        // timer, up to an hour away), leaving it unretried meant a single
        // slow lock acquisition could permanently leave authConfirmed
        // false for the whole session: no Mixpanel identity, and for an
        // actual commissioner, no counted login. Flagged in PR review.
        //
        // `result.errored` (a fast query/network failure, as opposed to
        // the whole call timing out) gets the same retry — see
        // getCommissionerRole's own comment on why a transient error must
        // never be treated as a confirmed "no member claimed" answer.
        console.warn("Auth state change: getCommissionerRole failed or timed out — retrying once");
        try {
          result = await withTimeout(getCommissionerRole(session), 10000, null);
        } catch (e) {
          result = null;
        }
        if (!isMounted) return;
        if (!result || result.errored) {
          // Still no confirmed answer for member_id — leave memberId/the
          // cached identity exactly as they are rather than falling
          // through to the auto-claim path below, which would otherwise
          // treat this unresolved failure as "not claimed yet" and could
          // overwrite a perfectly good cached member_id with null.
          //
          // The commissioner role is a separate story: when `result`
          // exists at all (an `errored` result, as opposed to an outright
          // `!result` double-timeout with no data whatsoever),
          // getCommissionerRole() already derived its `role` from the
          // email allowlist check alone, independent of the profiles
          // query that actually failed — so it's just as reliable as a
          // clean lookup and safe to apply, instead of leaving a
          // first-time/uncached commissioner stuck locked out of
          // commissioner-only controls until some later auth event
          // happens to succeed (next token refresh could be up to an
          // hour away). Flagged in PR review.
          console.warn("Auth state change: getCommissionerRole failed twice — leaving memberId as-is");
          if (result) setCommissionerRole(result.role);
          setAuthReady(true);
          return;
        }
      }

      const { role, memberId: claimedMemberId } = result;
      if (!isMounted) return;
      setCommissionerRole(role);

      if (claimedMemberId) {
        setMemberId(claimedMemberId);
        // Confirmed, real identity — cache it so the NEXT load (a refresh,
        // most likely) can paint this immediately instead of starting from
        // "Set your name" again while this same lookup re-runs. See the
        // "Optimistic auth hydration" comment above App().
        writeCachedIdentity(role, claimedMemberId);
        setAuthReady(true);
        setAuthConfirmed(true);
        // Fire-and-forget: this early-return path used to skip
        // auto_claim_member_identity() entirely once member_id was
        // already set, which silently broke phase18's own "backfills
        // claim_method the next time this member signs in" promise for
        // EVERY already-claimed profile — the one case that promise was
        // actually meant to cover. The RPC is idempotent and already
        // swallows its own errors (autoClaimMemberIdentityRpc(), above),
        // and nothing here needs its result — claimedMemberId is already
        // known — so it's called without awaiting it.
        autoClaimMemberIdentityRpc();
        return;
      }

      // No identity claimed yet — try the automatic email-mapped claim
      // (supabase/phase13_email_member_map.sql) before falling back to the
      // manual picker in the account menu. Safe to attempt every time
      // memberId comes back null: it's a no-op if there's no mapping.
      const autoClaimedId = await autoClaimMemberIdentityRpc();
      if (!isMounted) return;
      if (autoClaimedId) {
        setMemberId(autoClaimedId);
        track(EVENTS.MEMBER_CLAIMED, { member_id: autoClaimedId, method: "auto" });
        writeCachedIdentity(role, autoClaimedId);
      } else {
        setMemberId(null);
        writeCachedIdentity(role, null);
      }
      setAuthReady(true);
      setAuthConfirmed(true);
    });
 
    return () => {
      isMounted = false;
      listener?.subscription?.unsubscribe();
    };
  }, []);

  // Identify to Mixpanel as soon as there's a session — including the
  // optimistic, not-yet-confirmed one from localStorage hydration above.
  // identifyPerson() is explicitly safe to call repeatedly (a no-op once
  // it's already using the given id — see analytics.js), so there's no
  // correctness reason to make it wait for authConfirmed: doing so was
  // itself a bug (flagged in PR review) — a role-lookup timeout left
  // authConfirmed false with nothing left to retry it, which silently
  // dropped that entire session's activity to the anonymous $device_id
  // instead of the signed-in profile, exactly the race this file's
  // "Known limitation" note already describes, just stretched from a
  // split-second to potentially the whole session.
  useEffect(() => {
    if (!commissionerSession) return;
    identifyPerson({
      userId: commissionerSession?.user?.id,
      email: commissionerSession?.user?.email,
      memberId,
    });
  }, [commissionerSession, memberId]);

  // Commissioner Signed In/Out tracking — kept on its own effect, gated on
  // authConfirmed (not just authReady/a session existing), because unlike
  // identifyPerson() above this bookkeeping is NOT idempotent:
  // markCommissionerLogin() increments commissioner_login_count once per
  // call, so counting it off the optimistic/unconfirmed role guess risks
  // a real over-count if that guess turns out wrong moments later.
  const prevSignedInRef = useRef(false);
  const prevHadSessionRef = useRef(false);
  useEffect(() => {
    if (!authConfirmed) return;
    const signedIn = commissionerRole === "commissioner" || commissionerRole === "admin";
    const hasSession = !!commissionerSession;

    if (signedIn && !prevSignedInRef.current) {
      markCommissionerLogin(commissionerRole);
      track(EVENTS.COMMISSIONER_SIGNED_IN, { role: commissionerRole });
    } else if (!signedIn && prevSignedInRef.current) {
      track(EVENTS.COMMISSIONER_SIGNED_OUT);
    }
    prevSignedInRef.current = signedIn;

    // Any sign-out (commissioner or plain member) breaks the identity
    // link so a later visitor on a shared device doesn't inherit it —
    // the account menu's visible "Sign out" exists specifically for this.
    if (!hasSession && prevHadSessionRef.current) {
      resetIdentity();
    }
    prevHadSessionRef.current = hasSession;
  }, [authConfirmed, commissionerRole, commissionerSession]);

  const lastSourceRef = useRef(null);
  const loadSeason = useCallback(async (showRefreshing = false, trigger) => {
    var resolvedTrigger = trigger || (showRefreshing ? "manual_refresh" : "initial");
    if (showRefreshing) setRefreshing(true);
    // 10s timeout: a signed-in Supabase client can internally hang while
    // resolving the session before firing this request (SDK quirk) — fall
    // back exactly like an outright failure rather than spinning forever.
    let active = await withTimeout(fetchSeasonFromSupabase(), 10000, null);
    let source = "supabase";
    // Whenever this resolved, not necessarily "now" — see below.
    let resolvedAt = new Date();
    if (!active) {
      console.warn("Supabase fetch failed, trying localStorage...");
      const cached = readCachedActiveSeason();
      if (cached) {
        active = cached.season;
        source = "local";
        // The data is from whenever that earlier fetch actually
        // succeeded, not from this failed retry — showing "now" here
        // would claim freshness it doesn't have (see the dataSource
        // "local" status dot further down).
        resolvedAt = cached.cachedAt ? new Date(cached.cachedAt) : new Date();
      }
      track(EVENTS.DATA_FALLBACK_USED, {
        surface: "season",
        fallback_level: source === "local" ? "local" : "hardcoded",
        reason: "supabase_fetch_failed",
      });
    }
    if (!active) { console.warn("No stored data, using hardcoded build2025()..."); active = build2025(); source = "hardcoded"; }
    if (source === "supabase") cacheActiveSeason(active);

    // Set the real numbers immediately — projections are a nice-to-have
    // overlay (below), never worth delaying the actual scoreboard for.
    // Carry over whatever projections the PREVIOUS activeSeason already
    // had for this same year instead of resetting to {} here —
    // loadSeason() runs on every realtime-triggered reload too (several
    // times during a single manual Refresh; see #61/#62), and a fresh
    // fetchSeasonFromSupabase() result never includes projections at all
    // (a separate fetch, below). Without this, Scoreboard.jsx's
    // "Projected Final" toggle — gated on projections being non-empty —
    // would disappear and reappear on every single reload cycle,
    // bouncing the whole standings layout under it. The fetch below
    // still always runs and replaces this with the real current
    // projections once it resolves; this only avoids the pointless
    // blank in between.
    setActiveSeason((prev) => {
      active.projections = (prev && prev.year === active.year && prev.projections) || {};
      return active;
    });
    setDataSource(source);
    setLastUpdated(resolvedAt);
    setSeasonSuperProperties({ year: active?.year, dataSource: source });
    track(EVENTS.SEASON_LOADED, { data_source: source, year: active?.year, is_refresh: showRefreshing, trigger: resolvedTrigger });
    lastSourceRef.current = source;
    if (showRefreshing) setRefreshing(false);

    // Only attempted against a real Supabase season, with its own
    // timeout, and patched in separately once it resolves instead of
    // making the real scoreboard above wait on it — degrades to {} on
    // any failure already (see docs/projections-feature-plan.md). Guard
    // against patching in a stale response onto a season the page has
    // since moved past (another loadSeason() call, or a year switch).
    if (source === "supabase") {
      const year = active.year;
      withTimeout(fetchProjectionsFromSupabase(active.year, active.members), 8000, {}).then((projections) => {
        setActiveSeason((prev) => (prev && prev.year === year ? { ...prev, projections } : prev));
      });
    }
    return active;
  }, []);
 
  useEffect(() => {
    // Active season and archived seasons don't depend on each other at
    // all — archived seasons are only ever used when explicitly viewing
    // one from the season picker, never for the default Scoreboard tab —
    // so there's no reason the second was ever sequenced after the
    // first instead of running alongside it.
    const seasonPromise = loadSeason();
    const archivedPromise = (async () => {
      let archived = [];
      try {
        // Same hang risk as loadSeason() above — same 10s safety net.
        const archivedResult = await withTimeout(
          supabasePublic.from('seasons').select('year').eq('status', 'archived').order('year', { ascending: false }),
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
      setArchivedLoaded(true);
      return archived;
    })();

    // The active season is the only thing the default view needs —
    // archived seasons (and projections, handled inside loadSeason
    // itself) are both background enrichment that used to block this
    // same flip for no reason tied to what's actually on screen first.
    seasonPromise.then(() => {
      setLoaded(true);
      setInitialSyncPending(false);
      // Only worth a "just now" confirmation flash if the escalated chip
      // was actually visible AND this resolved with a genuinely fresh
      // Supabase result — lastSourceRef.current is set synchronously
      // inside loadSeason() right before it returns, so it already
      // reflects whichever of "supabase"/"local"/"hardcoded" this call
      // actually landed on. Without that second check, a request that
      // times out after the chip was already showing would still flash
      // "Updated just now" over data lastUpdated has correctly stamped
      // with its real (older) cache time — claiming freshness that
      // isn't there, the exact mistake this whole feature exists to
      // avoid.
      if (syncDelayPassedRef.current && lastSourceRef.current === "supabase") {
        setJustSynced(true);
        setTimeout(() => setJustSynced(false), 2500);
      }
    });

    (async () => {
      const archived = await archivedPromise;
      await seasonPromise;
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
    let jobsSucceeded = 0, jobsFailed = 0, success = false, isSkipped = false;
    try {
      const res = await fetch("/api/refresh-all", { method: "POST" });
      const body = await res.json().catch(() => null);
      const jobs = (body && body.jobs) || [];
      jobsSucceeded = jobs.filter((j) => j.ok).length;
      jobsFailed = jobs.length - jobsSucceeded;
      success = !!(body && body.success);
      isSkipped = !!(body && body.skipped);
    } catch (e) {
      console.warn("Full refresh (crons) failed, falling back to a plain data refetch:", e);
    }
    track(EVENTS.DATA_REFRESH_TRIGGERED, {
      success, jobs_succeeded: jobsSucceeded, jobs_failed: jobsFailed, duration_ms: Date.now() - startedAt,
      is_skipped: isSkipped,
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
    cacheActiveSeason(newSeason);
    try { await storageSet(STORAGE_KEYS.ARCHIVED_SEASONS, JSON.stringify(newArchived)); } catch (e) {}
    setActiveTab("scoreboard");
  }, [activeSeason, archivedSeasons]);
 
  // `updater` is a function (prev) => updatedSeason, not an
  // already-computed object — SeasonSettings.jsx's own toggleLock/
  // addDetailRow/deleteDetailRow/applyChanges/applyPaywallChanges all
  // build their patch this way now instead of cloning the `seasonData`
  // prop they were handed. That prop can be stale the instant two of
  // those fire close together (a fast double-click, or two separate
  // instant-save actions landing in the same tick before React delivers
  // the first one's result back down as a new prop) — each used to clone
  // from the SAME pre-save season, so the second call's onSave silently
  // discarded whichever change wasn't the last one to reach
  // setActiveSeason, not whichever the commissioner actually intended to
  // keep. Running the updater inside setActiveSeason's own functional
  // form means it always applies on top of the real current state,
  // never a stale snapshot — the same reason loadSeason() elsewhere in
  // this file uses the functional form for its projections patch.
  const handleSettingsSave = useCallback(async (updater) => {
    if (!isCommissioner) {
      throw new Error("Commissioner access required to save season settings.");
    }
    let updatedSeason, prevSeasonRef;
    setActiveSeason((prev) => {
      prevSeasonRef = prev;
      updatedSeason = updater(prev);
      return updatedSeason;
    });
    // An updater signals "nothing actually changed" by returning the
    // exact `prev` reference it was handed rather than a new object —
    // applyChanges() does this when there were no pending edits to save.
    // Skip the cache write and the two Supabase round-trips entirely in
    // that case, the same no-op short-circuit the old, pre-refactor code
    // had before it ever touched onSave at all.
    if (updatedSeason === prevSeasonRef) return;
    cacheActiveSeason(updatedSeason);
    // Both save calls return a boolean rather than throwing (see their
    // own comments in storage.js) — previously neither was checked, so a
    // failed Supabase write (network blip, RLS hiccup, migration not yet
    // applied) was invisible to the commissioner: the UI already showed
    // the change as saved, and it would silently revert on the next
    // reload/realtime refresh with no error ever surfaced. Local state
    // and the cache are deliberately left as the optimistic new value
    // either way — reverting them here would just be a second, different
    // kind of surprise (the commissioner's own edit vanishing mid-session)
    // — but the thrown error below is what lets a caller that awaits this
    // (every onSave call site in SeasonSettings.jsx now does) show that
    // the write didn't actually persist.
    let locksOk = true, paywallsOk = true;
    if (updatedSeason.locks && updatedSeason.year) {
      locksOk = await saveLocksToSupabase(updatedSeason.year, updatedSeason.locks);
    }
    if (updatedSeason.paywalls && updatedSeason.year) {
      paywallsOk = await savePaywallsToSupabase(updatedSeason.year, updatedSeason.paywalls);
    }
    if (!locksOk || !paywallsOk) {
      throw new Error(
        "Saved locally, but the write to Supabase failed (" +
        [!locksOk && "locks", !paywallsOk && "paywalls"].filter(Boolean).join(", ") +
        ") — this change may revert on the next reload. Check your connection and try again."
      );
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
      cacheActiveSeason(updated);
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
  // separate step of the mount effect. Gating on archivedLoaded — which
  // only flips true once that fetch has actually settled — is what
  // actually waits long enough for a legitimate archived-year deep link
  // not to be misjudged as invalid and reset before archivedSeasons has
  // had a chance to arrive. (`loaded` doesn't mean that anymore: it flips
  // as soon as the active season alone is in hand, including instantly
  // from cache, specifically so this screen doesn't wait on archived
  // seasons to render — see the mount effect.)
  useEffect(() => {
    if (!archivedLoaded || selectedYear === null || !activeSeason) return;
    if (!availableSeasons.some((s) => s.year === selectedYear)) setSelectedYear(activeSeason.year);
  }, [archivedLoaded, availableSeasons, selectedYear, activeSeason]);

  const isViewingActive = !activeSeason || selectedYear === null || selectedYear === activeSeason.year;

  // The full season object for whatever year is selected — used by
  // Scoreboard and Trends, which both need more than just the year number.
  const viewingSeasonData = useMemo(() => {
    if (!activeSeason) return null;
    if (isViewingActive) return activeSeason;
    return archivedSeasons.find((s) => s && s.year === selectedYear) || activeSeason;
  }, [activeSeason, archivedSeasons, selectedYear, isViewingActive]);

  // Derived once and reused below (the orientation strip's clear-effect,
  // and the Realtime subscription further down) instead of each computing
  // its own ternary — same value, same reasoning either place.
  const activeYear = activeSeason ? activeSeason.year : null;

  // "This Week" orientation strip data — the biggest score_history mover
  // over the last ~7 days, and the next calendar_events entry. Both are
  // best-effort glances, not core data: any fetch problem just leaves that
  // half of the strip empty rather than showing an error.
  //
  // Clearing and fetching are deliberately two separate effects. Clearing
  // used to happen at the top of the fetch effect itself, keyed on the
  // whole `activeSeason` object — but `loadSeason()` hands back a new
  // object on every call, including the quiet reloads Realtime triggers
  // (see below), so every auto-update blanked this strip for the ~1-2s the
  // refetch took, then popped it back in: a visible flash and layout
  // shift, on a loop, for anyone with the tab open. Keying the clear on
  // just the year means it still resets on a genuine season change (new
  // draft finalized) — the scenario the clear exists for — but a same-
  // season realtime refresh now just replaces the numbers in place once
  // the new fetch resolves, with the strip staying put in between.
  useEffect(() => {
    setBiggestRiser(null);
    setBiggestFaller(null);
    setNextEvent(null);
  }, [activeYear]);

  useEffect(() => {
    if (!activeSeason || !activeSeason.year) return;
    let cancelled = false;
    const yr = activeSeason.year;
    const memberNameById = {};
    (activeSeason.members || []).forEach((m) => { memberNameById[m.id] = m.name; });

    (async () => {
      try {
        // One round-trip via the biggest_score_movers RPC (see
        // supabase/phase21_orientation_strip_rpc.sql) instead of the
        // three sequential queries (find latest date, find baseline
        // date, fetch both dates' rows) this used to take — each
        // depended on the last, so that was three full round-trips of
        // real latency before a best-effort banner could even appear.
        const movers = await fetchBiggestScoreMovers(yr);
        if (cancelled || movers.length === 0) return;

        let riser = null, faller = null;
        movers.forEach((m) => {
          const delta = Number(m.delta) || 0;
          if (delta > 0 && (!riser || delta > riser.delta)) riser = { memberId: m.member_id, delta: delta };
          if (delta < 0 && (!faller || delta < faller.delta)) faller = { memberId: m.member_id, delta: delta };
        });
        if (cancelled) return;
        // Explicitly null out a side with no mover this cycle (not just
        // "leave whatever was there") — this is a genuine, successful
        // result, not an error or an inconclusive fetch, so a stale mover
        // from a previous week must not linger once it's no longer true.
        setBiggestRiser(riser ? { name: memberNameById[riser.memberId] || riser.memberId, delta: riser.delta } : null);
        setBiggestFaller(faller ? { name: memberNameById[faller.memberId] || faller.memberId, delta: faller.delta } : null);
      } catch (e) {
        console.warn("Orientation strip: score_history fetch failed, omitting riser/faller:", e);
      }
    })();

    (async () => {
      try {
        const todayStr = new Date().toISOString().slice(0, 10);
        // supabasePublic, not supabase — a plain public read with no
        // reason to wait on the session-aware client's internal auth
        // lock (see that client's own comment in storage.js).
        const { data, error } = await supabasePublic
          .from("calendar_events")
          .select("title, event_date")
          .eq("season_year", yr)
          .gte("event_date", todayStr)
          .order("event_date")
          .order("sort_order")
          .limit(1);
        if (cancelled || error) return; // fetch failed — leave whatever was already shown
        if (!data || data.length === 0) { setNextEvent(null); return; } // succeeded: genuinely nothing upcoming (e.g. past the season's last event)
        setNextEvent({ title: data[0].title, date: data[0].event_date });
      } catch (e) {
        console.warn("Orientation strip: calendar_events fetch failed, omitting next event:", e);
      }
    })();

    return () => { cancelled = true; };
  }, [activeSeason]);

  // ── Live scores via Supabase Realtime ──
  // The crons in vercel.json (update-sports, update-stocks, etc.) run on
  // their own daily schedule whether or not anyone has the app open — see
  // supabase/phase8_realtime.sql. Without this subscription, a league
  // member only ever sees a cron's result after clicking Refresh (which
  // also re-fetches) or reloading the page. This augments that button,
  // it doesn't replace it: Refresh still hits /api/refresh-all to run the
  // crons on demand, which realtime can't do — this just picks up
  // whatever a cron already wrote, for whoever's looking at the live
  // season, without them lifting a finger.
  const [realtimeLive, setRealtimeLive] = useState(false);
  const [justSynced, setJustSynced] = useState(false);
  // True from the moment a cron's database change schedules a reload
  // until that reload resolves — the realtime counterpart to
  // initialSyncPending above. Unlike that one, this isn't time-gated
  // behind an extra delay: scheduleReload's own 1200ms debounce already
  // absorbs a burst of individual row changes into one reload, so a
  // second gate here would just delay the warning past the point where
  // the scoreboard/activity feed numbers have already silently changed
  // underneath it — the exact "why did that just flicker with no
  // warning" gap this is meant to close.
  const [realtimeSyncPending, setRealtimeSyncPending] = useState(false);
  useEffect(() => {
    if (!isViewingActive || !activeYear) {
      setRealtimeLive(false);
      return;
    }
    let cancelled = false;
    let debounceTimer = null;
    // A cron that keeps writing past the 1200ms debounce window queues a
    // second reload while the first is still awaiting its network
    // round-trip — two overlapping cycles, not one. realtimeSyncPending
    // must stay true for as long as EITHER a debounce is still armed
    // (hasn't fired yet) OR a fetch is actually in flight; a plain
    // true/false flag that one cycle's resolution clears unconditionally
    // would drop it while the other cycle is still working. Both checks
    // below run synchronously, before any `await`, so there's no tick
    // where a just-fired timer has armed nothing yet but also hasn't
    // incremented inFlightReloads yet.
    let inFlightReloads = 0;
    function updateRealtimeSyncPending() {
      setRealtimeSyncPending(!!debounceTimer || inFlightReloads > 0);
    }

    // A single cron run touches many `picks` rows (plus several
    // `score_events` inserts) in one burst — debounce so that burst
    // becomes one quiet reload, not a dozen. realtimeSyncPending goes
    // true the moment the first change in a burst arrives, well before
    // the numbers actually change, so the status chip can warn "updating"
    // ahead of the flicker instead of only confirming it after the fact.
    function scheduleReload() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        debounceTimer = null;
        if (cancelled) return;
        inFlightReloads++;
        updateRealtimeSyncPending();
        try {
          await loadSeason(false, "realtime");
        } finally {
          inFlightReloads--;
        }
        if (cancelled) return;
        updateRealtimeSyncPending();
        // Same reasoning as the mount effect's equivalent check: only a
        // genuinely fresh Supabase result earns the "just now"
        // confirmation — a reload that silently fell back to cached or
        // hardcoded data shouldn't claim freshness it doesn't have.
        if (lastSourceRef.current === "supabase") {
          setJustSynced(true);
          setTimeout(() => { if (!cancelled) setJustSynced(false); }, 2500);
        }
      }, 1200);
      updateRealtimeSyncPending();
    }

    const channel = supabase
      .channel("season-" + activeYear + "-live")
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "picks", filter: "season_year=eq." + activeYear },
        scheduleReload)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "score_events", filter: "season_year=eq." + activeYear },
        scheduleReload)
      .subscribe((status) => { if (!cancelled) setRealtimeLive(status === "SUBSCRIBED"); });

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      setRealtimeLive(false);
      setRealtimeSyncPending(false);
      supabase.removeChannel(channel);
    };
  }, [activeYear, isViewingActive, loadSeason]);

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
        // Not literal 0 — body's own safe-area padding (public/index.html)
        // only clears the status bar/notch on initial load; once this
        // sticks during scroll, position:sticky recalculates against the
        // viewport directly, bypassing that padding. Pinning top to the
        // same env() value keeps it below the status bar in standalone
        // (Added to Home Screen) mode even after scrolling, with no
        // effect in an ordinary browser tab where it's 0px.
        position: "sticky", top: "env(safe-area-inset-top, 0px)", zIndex: 100,
      }}>
        <div style={{ maxWidth: (isWide && activeTab === "scoreboard") ? 1080 : 900, margin: "0 auto" }}>
          {/* Title row */}
          <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12,
            marginBottom: isMobile ? 10 : 16 }}>
            <Trophy size={isMobile ? 22 : 28} color={theme.acc} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 style={{
                fontSize: isMobile ? 18 : 22, fontWeight: 800, margin: 0, color: "#FAFAFA",
              }}>Fantasy Life</h1>
            </div>
            {pushSupported && (
              <button
                onClick={handlePushToggle}
                title={pushEnabled ? "Turn off notifications" : "Get notified about score updates"}
                style={{
                  background: "none",
                  border: "1px solid " + theme.bdr,
                  borderRadius: 8,
                  padding: isMobile ? "6px" : "6px 8px",
                  color: pushEnabled ? theme.acc : theme.dim,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  flexShrink: 0,
                }}>
                {pushEnabled ? <Bell size={16} /> : <BellOff size={16} />}
              </button>
            )}
            {/* Account menu — always visible on every tab, not just Draft/Settings,
                so it's never ambiguous who (if anyone) is signed in on this
                device. Avatar + name double as the "who's logged in" signal;
                the dropdown's explicit Sign out exists so a shared device
                doesn't silently stay logged in as whoever used it last. */}
            {authReady && (
              <div style={{ position: "relative", flexShrink: 0 }}>
                {commissionerSession ? (
                  <>
                    <button
                      onClick={() => setShowAccountMenu((v) => !v)}
                      style={{
                        display: "flex", alignItems: "center", gap: 6,
                        background: "none",
                        border: "1px solid " + theme.bdr,
                        borderRadius: 8,
                        padding: isMobile ? "4px 6px" : "4px 10px 4px 6px",
                        color: theme.txt,
                        cursor: "pointer",
                      }}>
                      <span style={{
                        width: 20, height: 20, borderRadius: "50%",
                        background: (memberId && MEMBER_COLORS[memberId]) || theme.dim,
                        color: "#fff", fontSize: 11, fontWeight: 700,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        flexShrink: 0,
                      }}>
                        {(accountDisplayName || "?").charAt(0).toUpperCase()}
                      </span>
                      {!isMobile && (
                        <span style={{ fontSize: 11, fontWeight: 700 }}>
                          {accountDisplayName || "Set your name"}
                        </span>
                      )}
                    </button>
                    {showAccountMenu && (
                      <>
                        <div onClick={() => setShowAccountMenu(false)}
                          style={{ position: "fixed", inset: 0, zIndex: 150 }} />
                        <div style={{
                          position: "absolute", top: "calc(100% + 6px)", right: 0,
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
                {authError && (
                  <div style={{
                    position: "absolute", top: "100%", right: 0, marginTop: 4,
                    fontSize: 10, color: "#fca5a5", whiteSpace: "nowrap",
                  }}>
                    {authError}
                  </div>
                )}
              </div>
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
            <button onClick={() => {
                track(EVENTS.TAB_VIEWED, { tab_name: "settings", previous_tab: activeTab, is_mobile: isMobile });
                setActiveTab("settings");
              }}
              title="Settings"
              style={{
                background: "none",
                border: "1px solid " + (activeTab === "settings" ? theme.acc : theme.bdr),
                borderRadius: 8,
                padding: isMobile ? "5px 7px" : "6px 9px",
                color: activeTab === "settings" ? theme.acc : theme.mut,
                cursor: "pointer",
                display: "flex", alignItems: "center",
                flexShrink: 0,
              }}>
              <SettingsIcon size={isMobile ? 14 : 15} />
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
      <div key={activeTab} style={{ padding: isMobile ? "12px 8px" : "20px 16px", animation: "fadeSlideIn 0.2s ease" }}>
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
              {/* Two different moments share this same louder chip — same
                  spinner + pill treatment validated in the design mockup
                  for this (https://claude.ai/artifact/EFoSniEDWCpcBBGUz1t7kg):
                  a breathing dot alone read as ambiguous/decorative, the
                  spinner is what actually registered as "something is
                  happening," and the compact inline footprint won over a
                  full banner row once both had the same spinner.
                  (1) A cache-seeded first paint still waiting on the real
                  fetch behind it, once that's taken long enough to
                  actually notice (initialSyncPending && syncDelayPassed).
                  (2) A cron's database change about to replace the
                  numbers currently on screen (realtimeSyncPending) — this
                  one isn't delay-gated; without it, the scoreboard and
                  activity feed would just silently flicker to new values
                  with the status dot sitting there saying "Live" the
                  whole time, and only pulse a confirmation after the
                  numbers had already changed with no warning.
                  (3) refreshing — a manual Refresh click runs EVERY
                  data-updating cron job in sequence (see handleRefresh),
                  each writing its own rows as it finishes, which fires its
                  own independent realtimeSyncPending cycle through the
                  same subscription (2) relies on. Without folding
                  refreshing in here too, those ~10 separate cycles each
                  resolve on their own timeline, so the chip itself would
                  flicker on and off every couple of seconds for the whole
                  refresh instead of staying up as the one continuous
                  operation it actually is from the user's side. */}
              {lastUpdated && isViewingActive && (
                // Fixed-height wrapper so swapping between the louder pill
                // (padding + border) and the plain status line (no padding,
                // smaller font) never changes this row's height — without
                // it, every transition between the two nudged everything
                // below down and back up, a visible page jump each time.
                <div style={{ marginTop: 6, minHeight: 29, display: "flex",
                  alignItems: "center", justifyContent: "center" }}>
                  {(initialSyncPending && syncDelayPassed) || realtimeSyncPending || refreshing ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px",
                      borderRadius: 999, border: "1px solid " + theme.bdr, background: theme.srf,
                      fontSize: 12, fontWeight: 700, color: theme.txt }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                        style={{ flexShrink: 0, animation: "spin 1s linear infinite" }} aria-hidden="true">
                        <circle cx="12" cy="12" r="9" stroke={theme.bdr} strokeWidth="3" />
                        <path d="M21 12a9 9 0 0 0-9-9" stroke={theme.acc} strokeWidth="3" strokeLinecap="round" />
                      </svg>
                      Showing last-known scores from {lastUpdated.toLocaleTimeString()} — updating…
                    </span>
                  ) : (
                    <span style={{ fontSize: 10, color: theme.dim, opacity: 0.6,
                      display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                        background: dataSource === "supabase" ? theme.grn : dataSource === "local" ? theme.yel : theme.red,
                        animation: justSynced ? "livePulse 0.6s ease" : "none" }} />
                      {dataSource === "supabase" ? (realtimeLive ? "Live · auto-updating" : "Live") : dataSource === "local" ? "Cached" : "Offline"}
                      {" "}· {justSynced ? "Updated just now" : "Updated " + lastUpdated.toLocaleTimeString()}
                    </span>
                  )}
                </div>
              )}
              <style>{`
                @keyframes livePulse { 0% { transform: scale(1); } 45% { transform: scale(2.2); } 100% { transform: scale(1); } }
                @keyframes spin { to { transform: rotate(360deg); } }
              `}</style>
              {isViewingActive && (biggestRiser || biggestFaller || nextEvent) && (
                <div style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  gap: isMobile ? 10 : 16, flexWrap: "wrap",
                  marginTop: 14, padding: isMobile ? "7px 14px" : "8px 18px",
                  background: theme.card, border: `1px solid ${theme.bdr}`, borderRadius: 999,
                  fontSize: isMobile ? 11 : 12,
                }}>
                  {biggestRiser && (
                    <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <TrendingUp size={13} color={theme.grn} />
                      <b style={{ color: theme.acc }}>{biggestRiser.name}</b>
                      <span style={{ color: theme.dim }}>+{biggestRiser.delta} this week</span>
                    </span>
                  )}
                  {biggestRiser && biggestFaller && (
                    <span style={{ width: 1, height: 13, background: theme.bdr, flexShrink: 0 }} />
                  )}
                  {biggestFaller && (
                    <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <TrendingDown size={13} color={theme.red} />
                      <b style={{ color: theme.txt }}>{biggestFaller.name}</b>
                      <span style={{ color: theme.dim }}>{biggestFaller.delta} this week</span>
                    </span>
                  )}
                  {(biggestRiser || biggestFaller) && nextEvent && (
                    <span style={{ width: 1, height: 13, background: theme.bdr, flexShrink: 0 }} />
                  )}
                  {nextEvent && (
                    <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <CalendarIcon size={12} color={theme.dim} />
                      <span style={{ color: theme.dim }}>Next:</span>
                      <b style={{ color: theme.txt }}>{nextEvent.title}</b>
                      <span style={{ color: theme.dim }}>{fmtEventWhen(nextEvent.date)}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
            <Scoreboard seasonData={viewingSeasonData} onUnlockPaywall={isViewingActive ? handlePaywallUnlock : undefined} memberId={memberId} />
            <div style={{ maxWidth: 760, margin: "20px auto 0" }}>
              <AdUnit slot="9806940854" />
            </div>
          </div>
        )}
        {activeTab === "trends" && (
          <TabErrorBoundary>
            <Suspense fallback={<TabFallback />}>
              <Trends seasonData={viewingSeasonData} />
            </Suspense>
          </TabErrorBoundary>
        )}
        {activeTab === "calendar" && (
          <TabErrorBoundary>
            <Suspense fallback={<TabFallback />}>
              <Calendar seasonYear={viewingYear} />
            </Suspense>
          </TabErrorBoundary>
        )}
        {activeTab === "recap" && (
          <TabErrorBoundary>
            <Suspense fallback={<TabFallback />}>
              <DraftRecap seasonYear={viewingYear} />
            </Suspense>
          </TabErrorBoundary>
        )}
        {activeTab === "draft" && (
          <TabErrorBoundary>
            <Suspense fallback={<TabFallback />}>
              <DraftTool
                onFinalize={handleFinalize}
                isCommissioner={isCommissioner}
                commissionerEmail={commissionerSession?.user?.email || ""}
                memberId={memberId}
                currentSeasonYear={activeSeason?.year}
                currentSeasonMembers={activeSeason?.members}
              />
            </Suspense>
          </TabErrorBoundary>
        )}
        {activeTab === "settings" && (
          <TabErrorBoundary>
            <Suspense fallback={<TabFallback />}>
              <SeasonSettings
                seasonData={activeSeason}
                onSave={handleSettingsSave}
                isCommissioner={isCommissioner}
                commissionerEmail={commissionerSession?.user?.email || ""}
              />
            </Suspense>
          </TabErrorBoundary>
        )}
        {activeTab === "privacy" && (
          <TabErrorBoundary>
            <Suspense fallback={<TabFallback />}>
              <PrivacyPolicy />
            </Suspense>
          </TabErrorBoundary>
        )}
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
