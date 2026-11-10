import { useState, useEffect, useRef, memo } from "react";
import { AlertTriangle, Target, Users, Shuffle, Trophy, Pencil, Rocket, History as HistoryIcon, PartyPopper, Download, BarChart3, Eye, XCircle } from "lucide-react";
import { DRAFT_MEMBERS, MEMBER_COLORS, NEW_MEMBER_COLORS } from "../constants/members";
import { DRAFT_CATEGORIES, CATEGORY_ORDER, CATEGORY_KEY_TO_ID } from "../constants/categories";
import { PICK_OPTIONS } from "../constants/pickOptions";
import { theme, cardStyle, inputStyle, buttonStyle } from "../constants/theme";
import { generateSnakeOrder } from "../utils/helpers";
import {
  supabase,
  fetchDraftSession,
  subscribeDraftSession,
  startDraftSession,
  saveDraftSession,
  deleteDraftSession,
  fetchServerClockOffset,
  submitDraftPick,
  undoLastDraftPick,
} from "../utils/storage";
import { notifyTurn } from "../utils/push";
import { track, timeEvent, EVENTS } from "../utils/analytics";
import { Avatar } from "./Badges";

const TIMER_DURATION = 120;

// Invert CATEGORY_KEY_TO_ID: { nfl: "NFL", nba: "NBA", ... }
const DRAFT_ID_TO_CATEGORY_KEY = {};
Object.entries(CATEGORY_KEY_TO_ID).forEach(([key, id]) => {
  DRAFT_ID_TO_CATEGORY_KEY[id] = key;
});

// Categories whose "Custom..." free-text field gets a live "did you mean"
// lookup against api/draft-lookup.js, keyed the same way that endpoint's
// own `?category=`/`?sport=` params are — see that file's header comment
// for the full reasoning. Deliberately excludes tennis/golf/f1 (their
// scoring match depends on HTML-scraped pages, too fragile/slow to call
// live from an autocomplete) and country (already a closed, fully-
// curated dropdown as of the Country fix, no free text to spell-check).
const DRAFT_LOOKUP_CONFIG = {
  actor: { category: "actor" },
  actress: { category: "actress" },
  musician: { category: "musician" },
  stock: { category: "stock" },
  ncaaf: { category: "team", sport: "ncaaf" },
  ncaab: { category: "team", sport: "ncaab" },
  mls: { category: "team", sport: "mls" },
};

// How many seconds are left on a live session's clock right now — not a
// value written to the DB every second (see phase14_live_draft.sql's own
// comment on this), but derived locally from the three fields that ARE
// written: frozen while paused, counting down from timer_started_at while
// active. Every viewer (commissioner included) computes this the same
// way, off the same synced row, so there's exactly one clock, not one per
// browser that can drift from each other.
function computeLiveRemaining(session, nowMs) {
  if (!session) return 0;
  if (!session.timer_active || !session.timer_started_at) return session.timer_remaining;
  const elapsed = Math.floor((nowMs - new Date(session.timer_started_at).getTime()) / 1000);
  return Math.max(0, session.timer_remaining - elapsed);
}

// Every live write below applies its patch to local state optimistically
// before the Supabase round-trip even starts. If that write then fails
// (network blip, RLS hiccup), the optimistic guess is left standing with
// nothing to ever correct it — no successful write means no Realtime
// notification triggers the usual re-fetch. Worst case for a timer patch
// specifically: a clock shown as running but frozen at its starting
// value forever. Called after any failed saveDraftSession() to discard
// the bad guess and resync to whatever the server actually has.
async function reconcileAfterFailedSave(setLiveSession) {
  const real = await fetchDraftSession();
  setLiveSession(real);
}

// The "On The Clock" card, isolated into its own component specifically
// so the 1Hz tick that drives a live session's countdown display (below)
// re-renders just these few lines instead of the entire draft board,
// roster panel, and pick history alongside it every second. Everything
// here that isn't the tick itself (member, canControlTimer, the handlers)
// is still owned by DraftTool — this only pulls out the part that
// genuinely needs to update every second.
const DraftCountdown = memo(function DraftCountdown({
  liveSession, clockOffsetRef, member, isMobile, canControlTimer, currentPick,
  pickCount, timer, timerActive, onPause, onStart, onReset, onUndo,
}) {
  // Local-only tick for a live session's countdown display — only runs
  // while a live timer is actually active, and never writes anything;
  // see computeLiveRemaining() above.
  const [liveNow, setLiveNow] = useState(() => Date.now());
  useEffect(() => {
    if (!liveSession || !liveSession.timer_active) return;
    const id = setInterval(() => setLiveNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [liveSession && liveSession.timer_active, liveSession && liveSession.timer_started_at]);

  const displayTimerActive = liveSession ? !!liveSession.timer_active : timerActive;
  const displayTimer = liveSession ? computeLiveRemaining(liveSession, liveNow + clockOffsetRef.current) : timer;

  return (
    <div style={{ ...cardStyle, marginBottom: 16, textAlign: "center",
      border: `2px solid ${MEMBER_COLORS[member ? member.id : ""] || theme.acc}` }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: theme.mut, textTransform: "uppercase",
        letterSpacing: 1, marginBottom: isMobile ? 4 : 8 }}>
        On The Clock · Pick #{currentPick + 1}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
        marginBottom: isMobile ? 8 : 12 }}>
        {member && <Avatar name={member.name} color={MEMBER_COLORS[member.id]} size={isMobile ? 28 : 34} />}
        <span style={{ fontSize: isMobile ? 22 : 28, fontWeight: 800,
          color: MEMBER_COLORS[member ? member.id : ""] }}>
          {member ? member.name : ""}
        </span>
      </div>
      <div style={{ fontSize: isMobile ? 36 : 48, fontWeight: 800, fontFamily: "monospace",
        color: displayTimer <= 15 ? theme.red : displayTimer <= 30 ? theme.yel : theme.txt, marginBottom: 8 }}>
        {Math.floor(displayTimer / 60)}:{String(displayTimer % 60).padStart(2, "0")}
      </div>
      {canControlTimer && (
        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
          {displayTimerActive
            ? <button onClick={onPause} style={buttonStyle(theme.yel)}>⏸ Pause</button>
            : <button onClick={onStart} style={buttonStyle(theme.grn)}>▶ Start</button>}
          <button onClick={onReset}
            style={{ ...buttonStyle(theme.srf), border: `1px solid ${theme.bdr}` }}>↻ Reset</button>
          {pickCount > 0 && (
            <button onClick={onUndo}
              style={{ ...buttonStyle(theme.srf), border: `1px solid ${theme.bdr}` }}>↩ Undo</button>
          )}
        </div>
      )}
    </div>
  );
});

export default function DraftTool({ onFinalize, isCommissioner, commissionerEmail, memberId, currentSeasonYear, currentSeasonMembers }) {
  const [phase, setPhase] = useState("setup");
  const [draftOrder, setDraftOrder] = useState([]);
  const [searchPhrase, setSearchPhrase] = useState("");
  const [actualResults, setActualResults] = useState("");
  const [guesses, setGuesses] = useState({});
  // Start from status quo — whoever's actually in the current season,
  // not a hardcoded list that goes stale the moment the league's roster
  // changes (a new member drafts in, someone sits a year out). Add/Remove
  // below still works exactly the same; this only changes the starting
  // point. DRAFT_MEMBERS is only a fallback for a brand-new league with
  // no season to read from yet. This naturally makes each finalized
  // draft's own roster the next year's starting point too, with no
  // separate "save as new default" step — next year's setup just reads
  // whatever season is active then, which by then is this one.
  const [activeMembers, setActiveMembers] = useState(() =>
    currentSeasonMembers && currentSeasonMembers.length
      ? currentSeasonMembers.map((m) => ({ id: m.id, name: m.name, full: m.full || m.name }))
      : [...DRAFT_MEMBERS]
  );
  const [showMemberMgmt, setShowMemberMgmt] = useState(false);
  const [newMemberName, setNewMemberName] = useState("");
  const [newMemberFull, setNewMemberFull] = useState("");
  const [manualOrder, setManualOrder] = useState(null);

  const [picks, setPicks] = useState({});
  const [currentPick, setCurrentPick] = useState(0);
  const [snakeOrder, setSnakeOrder] = useState([]);
  const [timer, setTimer] = useState(0);
  const [timerActive, setTimerActive] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showRoster, setShowRoster] = useState(null);
  const [customInput, setCustomInput] = useState("");
  const [customSuggestions, setCustomSuggestions] = useState([]);
  const [customLookupLoading, setCustomLookupLoading] = useState(false);
  const [pickHistory, setPickHistory] = useState([]);
  // Defaults to NEXT season (current season's year + 1), not literally
  // today's calendar year — a draft started partway through, say, 2026
  // is drafting the 2027 season, not re-drafting the one already running.
  const [seasonName, setSeasonName] = useState(
    () => "" + ((currentSeasonYear || new Date().getFullYear()) + 1)
  );
  const [showFinalizeModal, setShowFinalizeModal] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState("");
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Mobile: toggle panels instead of always showing
  const [mobilePanel, setMobilePanel] = useState("draft"); // "draft" | "rosters" | "history"
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  const timerRef = useRef(null);

  // Live "did you mean" lookup for the Custom field, against
  // api/draft-lookup.js — see DRAFT_LOOKUP_CONFIG above and that file's
  // own header comment for the full reasoning. Debounced so typing
  // doesn't fire a network request per keystroke; `cancelled` guards
  // against a slow response for an earlier keystroke landing after a
  // newer one already started (or the category/input changed again),
  // which would otherwise clobber the newer, more relevant result.
  useEffect(() => {
    const cfg = selectedCategory && DRAFT_LOOKUP_CONFIG[selectedCategory.id];
    const q = customInput.trim();
    if (!cfg || !q) { setCustomSuggestions([]); setCustomLookupLoading(false); return; }
    let cancelled = false;
    // Clear the PREVIOUS query's suggestions immediately, synchronously —
    // not just when the new result lands. Without this, editing the input
    // again left the old candidates rendered (and clickable) for the
    // entire debounce + network round-trip; clicking one in that window
    // would submit a canonical label that matched what was typed a moment
    // ago, not what the input currently shows. Caught in PR review.
    setCustomSuggestions([]);
    setCustomLookupLoading(true);
    const debounce = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ category: cfg.category, query: q });
        if (cfg.sport) params.set("sport", cfg.sport);
        const res = await fetch("/api/draft-lookup?" + params.toString());
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setCustomSuggestions(data.candidates || []);
      } catch (e) {
        if (!cancelled) setCustomSuggestions([]);
      } finally {
        if (!cancelled) setCustomLookupLoading(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(debounce); };
  }, [customInput, selectedCategory]);

  // ═══════════════════════════════════════════════════════════════
  // LIVE DRAFT — roadmap step 1 of 2 (see docs/live-draft-phase2.md
  // and supabase/phase14_live_draft.sql). A real, in-progress draft is
  // now one shared row in Supabase rather than private component state:
  // `liveSession` is `undefined` while that's still being checked,
  // `null` once confirmed there's no live draft (local setup/mock-draft
  // flow below applies, same as before this existed), or the session row
  // once one exists. Every viewer — including the commissioner's own
  // browser, which no longer keeps a separate local copy once a session
  // exists — subscribes and renders from this same row.
  // ═══════════════════════════════════════════════════════════════
  const [liveSession, setLiveSession] = useState(undefined);
  // This device's clock minus the database server's, in ms. A ref, not
  // state: updating it should never itself trigger a render, only feed
  // into the next tick's computeLiveRemaining() call.
  //
  // Calibrated from server_now() (fetchServerClockOffset(), phase17),
  // NOT from draft_sessions.updated_at — updated_at is only the time of
  // the LAST WRITE, which is stale the moment anyone opens or refreshes
  // the Draft tab without a write happening right then (the common
  // case: joining or reloading mid-countdown). Using it anyway briefly
  // made the countdown jump backward to its value as of that last write
  // (a real Codex finding on the first version of this fix). Calibrates
  // once on mount and every 60s after, for as long as this tab stays
  // open — a long enough interval that this device's clock can't drift
  // by anything the ~2-minute timer would ever show.
  const clockOffsetRef = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const calibrate = () => {
      fetchServerClockOffset().then((offset) => {
        if (!cancelled && offset !== null) clockOffsetRef.current = offset;
      });
    };
    calibrate();
    const id = setInterval(calibrate, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    let unsubscribe = null;
    const refresh = () => fetchDraftSession().then((row) => { if (!cancelled) setLiveSession(row); });
    refresh().then(() => {
      if (cancelled) return;
      // onReconnect: postgres_changes does NOT replay events missed while
      // this socket was dropped (a phone locking mid-draft, a wifi blip)
      // — force a fresh read the instant the channel comes back, instead
      // of hoping some other event eventually arrives to self-correct.
      unsubscribe = subscribeDraftSession(
        (next) => { if (!cancelled) setLiveSession(next); },
        refresh
      );
    });
    return () => { cancelled = true; if (unsubscribe) unsubscribe(); };
  }, []);

  // Backstop behind Realtime, not instead of it — insurance against a
  // silently-dead channel nobody would otherwise notice (Realtime having
  // an outage while the REST API is fine isn't something the app can
  // detect any other way). Also covers "this tab/phone was backgrounded
  // and just came back" more reliably than waiting on the socket's own
  // reconnect signal. Cheap at this scale (~12 people, one query each).
  useEffect(() => {
    let cancelled = false;
    const refresh = () => fetchDraftSession().then((row) => { if (!cancelled) setLiveSession(row); });
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", refresh);
    const id = setInterval(refresh, 45000);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", refresh);
      clearInterval(id);
    };
  }, []);

  // The 1Hz tick for a live session's countdown display now lives inside
  // DraftCountdown itself (below), not here — see that component's own
  // comment for why.

  // Seed the finalize screen's season-name input from the resumed
  // session — otherwise a commissioner who refreshes (or opens a second
  // tab) mid-draft sees today's year by default instead of whatever was
  // actually chosen at Start Draft time, and finalize uses THIS field for
  // the season year it saves under. Keyed on created_at (fixed for a
  // given session's whole lifetime) rather than liveSession itself, so
  // this fires once per resumed session, not on every pick/timer update —
  // it shouldn't clobber an edit the commissioner is mid-typing.
  useEffect(() => {
    if (liveSession && liveSession.season_name) setSeasonName(liveSession.season_name);
  }, [liveSession && liveSession.created_at]);

  // Anyone can run through setup and a full mock draft — only finalize is
  // gated — but until now nothing told a non-commissioner visitor that
  // none of it would be saved until the very last click. Only applies
  // when there's no real draft to watch instead — see spectatorBanner.
  const nonCommissionerBanner = !isCommissioner && !liveSession && (
    <div style={{ ...cardStyle, marginBottom: 16, border: "1px solid " + theme.yel,
      display: "flex", alignItems: "flex-start", gap: 10 }}>
      <AlertTriangle size={16} color={theme.yel} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ fontSize: 12, color: theme.dim, lineHeight: 1.5 }}>
        <b style={{ color: theme.yel }}>You're not signed in as commissioner.</b> You can run
        through this whole draft, but none of it will be saved — sign in with Google from the
        header to make it official.
      </div>
    </div>
  );

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Local mock-draft timer only — a live session's countdown is derived
  // inside DraftCountdown itself (computeLiveRemaining/liveNow there),
  // never ticked via setState in this component.
  useEffect(() => {
    if (liveSession) return;
    if (timerActive && timer > 0) {
      timerRef.current = setTimeout(() => setTimer((t) => t - 1), 1000);
    } else { setTimerActive(false); }
    return () => clearTimeout(timerRef.current);
  }, [timerActive, timer, liveSession]);

  const addMember = () => {
    if (!newMemberName.trim()) return;
    const id = newMemberName.trim().toLowerCase().replace(/\s+/g, "_");
    if (activeMembers.find((m) => m.id === id)) return;
    if (!MEMBER_COLORS[id]) MEMBER_COLORS[id] = NEW_MEMBER_COLORS[activeMembers.length % NEW_MEMBER_COLORS.length];
    setActiveMembers((prev) => {
      const next = [...prev, { id, name: newMemberName.trim(), full: newMemberFull.trim() || newMemberName.trim() }];
      track(EVENTS.DRAFT_MEMBER_ADDED, { member_count_after: next.length });
      return next;
    });
    setNewMemberName(""); setNewMemberFull("");
  };

  const removeMember = (memberId) => {
    if (activeMembers.length <= 2) return;
    setActiveMembers((prev) => {
      const next = prev.filter((m) => m.id !== memberId);
      track(EVENTS.DRAFT_MEMBER_REMOVED, { member_count_after: next.length });
      return next;
    });
    setGuesses((g) => { const n = { ...g }; delete n[memberId]; return n; });
    setDraftOrder((prev) => prev.filter((m) => m.id !== memberId));
    if (manualOrder) setManualOrder((prev) => prev.filter((m) => m.id !== memberId));
  };

  const calculateOrder = () => {
    const actual = parseInt(actualResults);
    if (isNaN(actual)) return;
    const sorted = activeMembers
      .map((m) => ({ ...m, guess: parseInt(guesses[m.id]) || 0 }))
      .map((m) => ({ ...m, diff: Math.abs(m.guess - actual) }))
      .sort((a, b) => a.diff - b.diff);
    setDraftOrder(sorted);
    track(EVENTS.DRAFT_ORDER_GENERATED, { method: "guess", member_count: sorted.length });
  };

  const randomizeOrder = () => {
    const shuffled = [...activeMembers]
      .map((m) => ({ ...m, guess: null, diff: null }))
      .sort(() => Math.random() - 0.5);
    setDraftOrder(shuffled);
    track(EVENTS.DRAFT_ORDER_GENERATED, { method: "random", member_count: shuffled.length });
  };

  // Commissioner: creates the shared live session so everyone else's
  // Draft tab picks it up. startDraftSession() is a plain insert, not an
  // upsert (see its own comment in storage.js) — if one already exists
  // this fails with a conflict rather than silently overwriting it, so
  // re-fetch and resume the REAL session instead of assuming the write
  // simply failed. Only once that re-fetch also comes back empty is it
  // safe to fall through to the local-only mock draft — a confirmed
  // absence, not just "this one request didn't work."
  const startDraft = async () => {
    if (draftOrder.length < 2) return;
    const so = generateSnakeOrder(draftOrder, DRAFT_CATEGORIES.length);
    track(EVENTS.DRAFT_STARTED, {
      member_count: draftOrder.length,
      round_count: DRAFT_CATEGORIES.length,
      total_picks: draftOrder.length * DRAFT_CATEGORIES.length,
    });
    timeEvent(EVENTS.DRAFT_FINALIZED);
    if (isCommissioner) {
      const row = await startDraftSession({ seasonName, draftOrder, snakeOrder: so, timerDuration: TIMER_DURATION });
      if (row) {
        setLiveSession(row);
        // The only turn assignment that doesn't flow through a
        // submit_draft_pick success (see makePick's own notifyTurn()
        // call) — the first pick of the draft needs the same push.
        // The "existing" resume path just below is deliberately NOT
        // included: resuming an already-live draft isn't a new turn
        // transition, the on-clock member was already on the clock.
        notifyTurn();
        return;
      }
      const existing = await fetchDraftSession();
      if (existing) { setLiveSession(existing); return; }
    }
    setSnakeOrder(so);
    setPhase("draft");
    setCurrentPick(0);
    setTimer(TIMER_DURATION);
  };

  // ── Unified state: whichever source applies right now ──
  // Everything below (rosters, history, the draft board, the on-the-clock
  // card) reads from `effective` rather than caring whether it came from
  // the live session or the local mock — see this file's "LIVE DRAFT"
  // comment above. Neither canControlTimer nor canPick (below) is just
  // `isCommissioner`: a non-commissioner still has full control of their
  // own private mock draft (unchanged, existing behavior), and once a
  // real draft is live, canPick further opens up to whoever's actually
  // on the clock (self-service picking) while canControlTimer stays
  // commissioner-only either way.
  const effective = liveSession
    ? {
        draftOrder: liveSession.draft_order,
        snakeOrder: liveSession.snake_order,
        picks: liveSession.picks,
        pickHistory: liveSession.pick_history,
        currentPick: liveSession.current_pick,
      }
    : { draftOrder, snakeOrder, picks, pickHistory, currentPick };
  // canControlTimer: unchanged — timer start/pause/reset and undo stay
  // commissioner-only even with self-service picking live (see
  // docs/live-draft-phase2.md's self-service section for why: those
  // writes still only ever come from one role, so there's no concurrency
  // to guard there, and giving every member clock control would just
  // invite collisions over who's allowed to pause whose turn).
  const canControlTimer = !liveSession || isCommissioner;
  const headerSeasonLabel = liveSession ? liveSession.season_name : seasonName;

  const isComplete = effective.snakeOrder.length > 0 && effective.currentPick >= effective.snakeOrder.length;
  const slot = !isComplete && effective.snakeOrder[effective.currentPick];
  const member = slot ? effective.draftOrder.find((m) => m.id === slot.memberId) : null;
  // isMyTurn is a UX convenience, NOT the security boundary — the real
  // authorization (including the claim_method check a manually-claimed
  // member fails) lives server-side in submit_draft_pick
  // (phase19_draft_pick_rpcs.sql). This just decides whether to even show
  // the pick UI to this browser.
  const isMyTurn = !!liveSession && !!memberId && !!slot && slot.memberId === memberId;
  const canPick = !liveSession || isCommissioner || isMyTurn;

  const getRoster = (mid) =>
    effective.pickHistory.filter((h) => h.memberId === mid).map((h) => ({
      category: DRAFT_CATEGORIES.find((c) => c.id === h.categoryId), pick: h.selection,
    }));

  const availCats = DRAFT_CATEGORIES.filter((cat) =>
    !Object.keys(effective.picks).some((k) => k.endsWith("-" + cat.id) && effective.picks[k] && k.startsWith((member ? member.id : "") + "-"))
  );

  // Surfaced errors from a failed live pick/undo attempt — see makePick's
  // own comment on why most of submit_draft_pick's rejection codes should
  // NOT alarm the user (stale_pick especially is the ordinary result of
  // losing a race or lagging a Realtime tick, not a bug).
  const [pickError, setPickError] = useState("");

  // Shown whenever this viewer can watch but not act right now — true for
  // every spectator, AND for a claimed member whose turn it currently
  // isn't. canPick (not isCommissioner alone) is what's actually watching
  // this here, now that self-service picking means a non-commissioner can
  // act too, just not at every moment.
  const spectatorBanner = !isCommissioner && liveSession && !canPick && (
    <div style={{ ...cardStyle, marginBottom: 16, border: "1px solid " + theme.acc,
      display: "flex", alignItems: "flex-start", gap: 10 }}>
      <Eye size={16} color={theme.acc} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ fontSize: 12, color: theme.dim, lineHeight: 1.5 }}>
        <b style={{ color: theme.acc }}>You're watching the live draft.</b>{" "}
        {member ? `${member.name} is on the clock` : "Waiting for the next pick"} — picks appear
        here the moment they're made. Pick buttons will show up right on this screen once it's
        your turn.
      </div>
    </div>
  );

  // Shown to a claimed, non-commissioner member exactly while it's their
  // turn — the self-service counterpart to spectatorBanner above.
  const yourTurnBanner = !isCommissioner && isMyTurn && (
    <div style={{ ...cardStyle, marginBottom: 16, border: "1px solid " + theme.grn,
      display: "flex", alignItems: "flex-start", gap: 10 }}>
      <Target size={16} color={theme.grn} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ fontSize: 12, color: theme.dim, lineHeight: 1.5 }}>
        <b style={{ color: theme.grn }}>It's your turn!</b> Pick a category below.
      </div>
    </div>
  );

  const pickErrorBanner = pickError && (
    <div style={{ ...cardStyle, marginBottom: 16, border: "1px solid " + theme.red,
      display: "flex", alignItems: "flex-start", gap: 10 }}>
      <AlertTriangle size={16} color={theme.red} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ fontSize: 12, color: theme.dim, lineHeight: 1.5 }}>{pickError}</div>
    </div>
  );

  // Guards against a double-fire (fast double-click, or a second pick
  // option clicked before the first one's round-trip to Supabase has
  // finished) submitting two picks for the same browser session before
  // the first one's response lands. Clearing the pick-selection UI
  // synchronously (not after the await) closes the window where it could
  // even happen from this one client; submit_draft_pick's own row lock
  // (phase19_draft_pick_rpcs.sql) is what guards against a DIFFERENT
  // client racing this one, which this ref can't see at all.
  const makingPickRef = useRef(false);
  const makePick = async (catId, selection, isCustom) => {
    if (!member || makingPickRef.current) return;
    if (liveSession && !canPick) return;
    makingPickRef.current = true;
    const key = member.id + "-" + catId;
    const expectedPick = effective.currentPick;
    // Computed fresh here, not from render-time state — the countdown
    // display's own 1Hz tick lives inside DraftCountdown now, not in this
    // component, so there's no per-second-fresh value sitting in scope to
    // read; this is the same pattern already used elsewhere in this file
    // (see the two computeLiveRemaining() calls below) for exactly that
    // reason.
    track(EVENTS.DRAFT_PICK_MADE, {
      pick_number: effective.currentPick + 1,
      round: effective.snakeOrder[effective.currentPick] ? effective.snakeOrder[effective.currentPick].round + 1 : null,
      category: DRAFT_ID_TO_CATEGORY_KEY[catId] || catId,
      member_id: member.id,
      is_custom_pick: !!isCustom,
      seconds_remaining: liveSession ? computeLiveRemaining(liveSession, Date.now() + clockOffsetRef.current) : timer,
      is_timer_active: liveSession ? !!liveSession.timer_active : timerActive,
    });
    setSelectedCategory(null); setSearchFilter(""); setCustomInput(""); setPickError("");
    if (isMobile) setMobilePanel("draft");

    try {
      if (liveSession) {
        // All of this — whose turn it really is, whether `selection` is
        // still actually available, applying the pick, advancing
        // current_pick, resetting the timer — happens in ONE locked,
        // server-side transaction now (see phase19_draft_pick_rpcs.sql's
        // own comment on why: once more than one browser can submit a
        // pick, this client constructing the "next" state itself and
        // pushing a patch — the old pattern, still used for the
        // commissioner-only timer controls below — is a real corruption
        // race). The RPC returns the full updated row directly, so this
        // client's own screen updates from that without waiting for a
        // second round-trip through Realtime.
        const { row, code } = await submitDraftPick(expectedPick, catId, selection, isCustom);
        if (row) {
          setLiveSession(row);
          notifyTurn();
        } else if (code === "stale_pick") {
          // The ordinary result of losing a race, or this client's view
          // just lagging one Realtime tick behind — not an error.
          setLiveSession(await fetchDraftSession());
        } else if (code === "network_error") {
          // The request itself never got a response — can't tell "lost
          // a race" apart from "that was actually MY successful write"
          // from the failure alone. Check ground truth: if pick_history
          // at this pick's index matches what was just attempted, it was
          // the latter — treat it as success, not an error.
          const real = await fetchDraftSession();
          setLiveSession(real);
          const landed = real && real.pick_history && real.pick_history[expectedPick];
          const isMine = landed && landed.categoryId === catId && landed.selection === selection;
          if (!isMine) setPickError("Couldn't confirm your pick went through — please try again.");
        } else {
          setLiveSession(await fetchDraftSession());
          setPickError(
            code === "not_your_turn" ? "It's not your turn anymore." :
            code === "claim_not_verified" ? "Your account isn't verified to pick for yourself yet — ask your commissioner to make this pick for you." :
            code === "selection_already_taken" ? "Someone already took that — pick again." :
            code === "category_already_picked" ? "You've already picked that category — choose a different one." :
            code === "draft_already_complete" ? "The draft is already complete." :
            "Something went wrong submitting that pick — please try again."
          );
        }
      } else {
        setPicks((p) => ({ ...p, [key]: selection }));
        setPickHistory((h) => [...h, { pick: currentPick, memberId: member.id, categoryId: catId, selection }]);
        setCurrentPick((c) => c + 1);
        setTimer(TIMER_DURATION); setTimerActive(true);
      }
    } finally {
      makingPickRef.current = false;
    }
  };

  const undoPick = async () => {
    if (effective.pickHistory.length === 0) return;
    track(EVENTS.DRAFT_PICK_UNDONE, { pick_number: effective.pickHistory.length });
    if (liveSession) {
      // Commissioner-only (gated by canControlTimer in the render below),
      // but still routed through the same locked-row RPC pattern as
      // makePick — not because concurrent undos are possible (only one
      // role can call this), but because a plain client-constructed
      // UPDATE could now race a MEMBER's pick landing between the
      // commissioner's last render and their Undo click. See
      // undo_last_draft_pick's own comment (phase19_draft_pick_rpcs.sql).
      const { row } = await undoLastDraftPick(liveSession.current_pick);
      setLiveSession(row || await fetchDraftSession());
      // Undo reassigns current_pick back to whoever it was before —
      // that member is newly on the clock again and deserves the same
      // push a fresh pick's turn transition gets (Codex-caught: this
      // path was the other turn transition notifyTurn() missed).
      if (row) notifyTurn();
    } else {
      const last = pickHistory[pickHistory.length - 1];
      setPicks((p) => { const n = { ...p }; delete n[last.memberId + "-" + last.categoryId]; return n; });
      setPickHistory((h) => h.slice(0, -1));
      setCurrentPick((c) => c - 1);
    }
    setSelectedCategory(null);
  };

  const handleTimerStart = async () => {
    track(EVENTS.DRAFT_TIMER_TOGGLED, { action: "start" });
    if (liveSession) {
      const remaining = computeLiveRemaining(liveSession, Date.now() + clockOffsetRef.current);
      // timer_started_at left null (not a client guess) so this
      // browser shows the flat `remaining` value, not yet ticking,
      // until the server-confirmed timestamp arrives — see the longer
      // comment on this same pattern in makePick() above.
      const patch = { timer_active: true, timer_started_at: null, timer_remaining: remaining };
      setLiveSession((s) => (s ? { ...s, ...patch } : s));
      if (!(await saveDraftSession(patch))) await reconcileAfterFailedSave(setLiveSession);
    } else {
      setTimerActive(true);
    }
  };
  const handleTimerPause = async () => {
    track(EVENTS.DRAFT_TIMER_TOGGLED, { action: "pause" });
    if (liveSession) {
      const remaining = computeLiveRemaining(liveSession, Date.now() + clockOffsetRef.current);
      const patch = { timer_active: false, timer_started_at: null, timer_remaining: remaining };
      setLiveSession((s) => (s ? { ...s, ...patch } : s));
      if (!(await saveDraftSession(patch))) await reconcileAfterFailedSave(setLiveSession);
    } else {
      setTimerActive(false);
    }
  };
  const handleTimerReset = async () => {
    track(EVENTS.DRAFT_TIMER_TOGGLED, { action: "reset" });
    if (liveSession) {
      // Gives a fresh 2:00 and keeps it running — same "shouldn't have
      // to restart" reasoning as the auto-restart-on-pick behavior above.
      // timer_started_at left null for the same no-glitch reason too.
      const patch = { timer_active: true, timer_started_at: null, timer_remaining: TIMER_DURATION };
      setLiveSession((s) => (s ? { ...s, ...patch } : s));
      if (!(await saveDraftSession(patch))) await reconcileAfterFailedSave(setLiveSession);
    } else {
      setTimer(TIMER_DURATION); setTimerActive(true);
    }
  };

  const cancelDraft = async () => {
    setCancelling(true);
    try {
      await deleteDraftSession();
      setLiveSession(null);
      setShowCancelModal(false);
    } finally {
      setCancelling(false);
    }
  };

  // ═══════════════════════════════════════════════════════════════
  // FINALIZE — saves everything to Supabase then calls onFinalize
  // ═══════════════════════════════════════════════════════════════
  const handleFinalize = async () => {
    if (!isCommissioner) return;
    setFinalizing(true);
    setFinalizeError("");

    const yearNum = parseInt(seasonName) || new Date().getFullYear();

    try {
      // ── 0. Pre-flight: check if picks already exist for this year ──
      const { count, error: checkErr } = await supabase
        .from("picks")
        .select("id", { count: "exact", head: true })
        .eq("season_year", yearNum);

      if (checkErr) {
        console.warn("Could not check existing picks:", checkErr.message);
      } else if (count && count > 0) {
        throw new Error(
          `Season ${yearNum} already has ${count} picks in the database. ` +
          `If you need to re-draft, delete the existing picks in Supabase first, ` +
          `or change the season year to ${yearNum + 1}.`
        );
      }

      // ── 1. Build the draft board JSONB ──
      // For each member, record which Supabase category key they picked in each round.
      // pickHistory is in global chronological order. snakeOrder tells us which member
      // was on the clock for each pick. We rebuild per-member round arrays.
      const memberRoundCats = {};
      effective.draftOrder.forEach((m) => { memberRoundCats[m.id] = []; });

      effective.snakeOrder.forEach((slot, idx) => {
        const histEntry = effective.pickHistory[idx];
        if (histEntry && histEntry.memberId === slot.memberId) {
          const catKey = DRAFT_ID_TO_CATEGORY_KEY[histEntry.categoryId] || histEntry.categoryId;
          memberRoundCats[slot.memberId].push(catKey);
        }
      });

      const draftBoardData = {
        memberOrder: effective.draftOrder.map((m) => m.id),
        board: memberRoundCats,
      };

      // ── 2. Ensure all draft members exist in the members table ──
      // This handles new members added during draft setup (e.g. Scott in 2026).
      // Uses upsert so existing members are untouched.
      const memberRows = effective.draftOrder.map((m) => ({
        id: m.id,
        name: m.name,
        full_name: m.full || m.name,
        color: MEMBER_COLORS[m.id] || "#64748b",
      }));

      const { error: memberErr } = await supabase
        .from("members")
        .upsert(memberRows, { onConflict: "id" });

      if (memberErr) {
        console.warn("Failed to upsert members:", memberErr.message);
        // Non-fatal — existing members will still work, only new members might fail on pick insert
      }

      // ── 3. Archive the current active season ──
      const { error: archiveErr } = await supabase
        .from("seasons")
        .update({ status: "archived" })
        .eq("status", "active");

      if (archiveErr) {
        console.warn("Failed to archive current season:", archiveErr.message);
        // Non-fatal — continue even if there's no active season to archive
      }

      // ── 4. Create (or update) the new season row ──
      // Use upsert so it works whether the row already exists or not.
      // We do NOT overwrite locks — if the row already exists with locks, keep them.
      const { data: existingSeason } = await supabase
        .from("seasons")
        .select("locks")
        .eq("year", yearNum)
        .maybeSingle();

      const { error: seasonErr } = await supabase
        .from("seasons")
        .upsert({
          year: yearNum,
          name: "Fantasy Life " + yearNum,
          status: "active",
          draft_date: new Date().toISOString(),
          draft_board: draftBoardData,
          locks: existingSeason?.locks || {},
        }, { onConflict: "year" });

      if (seasonErr) throw new Error("Failed to create season: " + seasonErr.message);

      // ── 5. Insert all picks (one row per member per category) ──
      const pickRows = [];
      CATEGORY_ORDER.forEach((catKey) => {
        const catId = CATEGORY_KEY_TO_ID[catKey];
        effective.draftOrder.forEach((m) => {
          const selection = effective.picks[m.id + "-" + catId] || "—";
          pickRows.push({
            season_year: yearNum,
            member_id: m.id,
            category: catKey,
            pick: selection,
            base: 0,
            bonus: 0,
            // Do NOT include total — it's a generated column
          });
        });
      });

      const { error: pickErr } = await supabase
        .from("picks")
        .insert(pickRows);

      if (pickErr) throw new Error("Failed to insert picks: " + pickErr.message);

      console.log(`✅ Season ${yearNum} saved to Supabase: ${pickRows.length} picks + draft board`);
      track(EVENTS.DRAFT_FINALIZED, { season_year: yearNum, member_count: effective.draftOrder.length, total_picks: pickRows.length });

      // The live session (if any) is done its job — nothing left for
      // anyone to watch, and deleting it is what lets the next season's
      // draft start fresh instead of resuming this one.
      if (liveSession) {
        await deleteDraftSession();
      }

      // ── 6. Build local season object and call onFinalize ──
      // This updates App.jsx state so Scoreboard shows the new season immediately.
      // On next refresh, App.jsx will re-fetch from Supabase anyway.
      const categories = {};
      CATEGORY_ORDER.forEach((catKey) => {
        const catId = CATEGORY_KEY_TO_ID[catKey];
        categories[catKey] = effective.draftOrder.map((m) => ({
          owner: m.name,
          pick: effective.picks[m.id + "-" + catId] || "—",
          base: 0,
          bonus: 0,
          total: 0,
        }));
      });

      onFinalize({
        year: yearNum,
        name: "Fantasy Life " + seasonName,
        draftDate: new Date().toISOString(),
        memberCount: effective.draftOrder.length,
        members: effective.draftOrder.map((m) => ({ id: m.id, name: m.name, full: m.full })),
        categories,
        detailedData: {},
        locks: existingSeason?.locks || {},
        status: "active",
      });

      setShowFinalizeModal(false);
    } catch (err) {
      console.error("Finalize error:", err);
      setFinalizeError(err.message || "Something went wrong saving to Supabase.");
      track(EVENTS.DRAFT_FINALIZE_FAILED, { season_year: yearNum, error_message: err.message || "unknown_error" });
    } finally {
      setFinalizing(false);
    }
  };

  const exportCSV = () => {
    track(EVENTS.DRAFT_CSV_EXPORTED, { member_count: effective.draftOrder.length });
    const lines = ["Member," + DRAFT_CATEGORIES.map((c) => c.name).join(",")];
    effective.draftOrder.forEach((m) => {
      lines.push(m.name + "," + DRAFT_CATEGORIES.map((c) => '"' + (effective.picks[m.id + "-" + c.id] || "") + '"').join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "draft_" + seasonName + ".csv"; a.click();
  };

  // ===== Still checking whether a live draft exists =====
  if (liveSession === undefined) {
    return (
      <div style={{ maxWidth: 600, margin: "40px auto", textAlign: "center", color: theme.dim, fontSize: 13 }}>
        Checking for a live draft...
      </div>
    );
  }

  // ===== SETUP PHASE (local mock only — a live draft skips straight to the draft phase below) =====
  if (phase === "setup" && !liveSession) {
    return (
      <div style={{ maxWidth: 600, margin: "0 auto" }}>
        <div style={{ ...cardStyle, marginBottom: 16, textAlign: "center" }}>
          <Target size={48} style={{ marginBottom: 8 }} color={theme.acc} />
          <h2 style={{ margin: "0 0 8px", fontSize: isMobile ? 18 : 22 }}>New Season Draft</h2>
          <p style={{ color: theme.dim, fontSize: 13 }}>Set up members, enter guesses, and determine draft order.</p>
        </div>

        {nonCommissionerBanner}

        {/* Member Management */}
        <div style={{ ...cardStyle, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h3 style={{ margin: 0, fontSize: 16, display: "flex", alignItems: "center", gap: 6 }}>
              <Users size={16} /> Members ({activeMembers.length})
            </h3>
            <button onClick={() => setShowMemberMgmt(!showMemberMgmt)}
              style={{ ...buttonStyle(theme.srf), fontSize: 11, padding: "4px 10px", border: `1px solid ${theme.bdr}` }}>
              {showMemberMgmt ? "Close" : "Manage"}
            </button>
          </div>
          {showMemberMgmt && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
                {activeMembers.map((m) => (
                  <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "6px 10px", borderRadius: 6, background: theme.srf }}>
                    <span style={{ fontWeight: 600, color: MEMBER_COLORS[m.id] }}>{m.name}</span>
                    <button onClick={() => removeMember(m.id)}
                      style={{ background: "none", border: "none",
                        color: activeMembers.length <= 2 ? "#475569" : "#ef4444",
                        cursor: activeMembers.length <= 2 ? "not-allowed" : "pointer", fontSize: 11, fontWeight: 700 }}>
                      ✕ Remove
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ padding: 12, borderRadius: 8, background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: theme.acc, marginBottom: 8 }}>+ Add New Member</div>
                <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: 8 }}>
                  <input value={newMemberName} onChange={(e) => setNewMemberName(e.target.value)}
                    placeholder="Display name" style={{ ...inputStyle, flex: 1 }}
                    onKeyDown={(e) => { if (e.key === "Enter") addMember(); }} />
                  <input value={newMemberFull} onChange={(e) => setNewMemberFull(e.target.value)}
                    placeholder="Full name (opt)" style={{ ...inputStyle, flex: 1 }}
                    onKeyDown={(e) => { if (e.key === "Enter") addMember(); }} />
                  <button onClick={addMember} disabled={!newMemberName.trim()}
                    style={{ ...buttonStyle(theme.grn), padding: "8px 16px", fontSize: 13, opacity: newMemberName.trim() ? 1 : 0.4 }}>
                    Add
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Google Results */}
        <div style={{ ...cardStyle, marginBottom: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: theme.mut, display: "block", marginBottom: 6 }}>Secret Word/Phrase</label>
          <input value={searchPhrase} onChange={(e) => setSearchPhrase(e.target.value)}
            placeholder="purple monkey dishwasher" style={inputStyle} />
          <div style={{ marginTop: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: theme.mut, display: "block", marginBottom: 6 }}>Actual Google Results</label>
            <input value={actualResults} onChange={(e) => setActualResults(e.target.value)}
              placeholder="e.g. 1234567" type="number" style={inputStyle} />
          </div>
        </div>

        {/* Guesses — hidden while Manage is open so the member list isn't
            shown twice in a row the user has to scroll past */}
        {!showMemberMgmt && (
        <div style={{ ...cardStyle, marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>Member Guesses</h3>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8 }}>
            {activeMembers.map((m) => (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, minWidth: 60, color: MEMBER_COLORS[m.id] }}>{m.name}</span>
                <input value={guesses[m.id] || ""}
                  onChange={(e) => setGuesses((g) => ({ ...g, [m.id]: e.target.value }))}
                  placeholder="Guess" type="number" style={{ ...inputStyle, width: isMobile ? "100%" : 120, flex: isMobile ? 1 : "unset" }} />
              </div>
            ))}
          </div>
        </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
          <button onClick={calculateOrder} style={{ ...buttonStyle(), width: "100%" }}>Calculate Draft Order</button>
          <button onClick={randomizeOrder}
            style={{ ...buttonStyle(theme.srf), width: "100%", border: `1px solid ${theme.bdr}`, color: theme.dim,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Shuffle size={14} /> Or Skip & Randomize Order
          </button>
        </div>

        {draftOrder.length > 0 && (
          <div style={{ ...cardStyle, marginBottom: 16 }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 16, display: "flex", alignItems: "center", gap: 6 }}>
              <Trophy size={16} color={theme.yel} /> Draft Order (Snake)
            </h3>
            <p style={{ color: theme.dim, fontSize: 12, margin: "0 0 8px" }}>
              {draftOrder.length} members → max base = {draftOrder.length}
            </p>
            {draftOrder.map((m, i) => (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                borderRadius: 8, background: i === 0 ? "rgba(234,179,8,0.1)" : theme.srf, marginBottom: 4 }}>
                <span style={{ fontSize: 20, fontWeight: 800, color: i === 0 ? theme.yel : theme.dim, minWidth: 30 }}>#{i + 1}</span>
                <span style={{ fontWeight: 700, color: MEMBER_COLORS[m.id], flex: 1 }}>{m.name}</span>
                {!isMobile && <span style={{ fontSize: 13, color: theme.mut }}>Guessed: {m.guess?.toLocaleString()}</span>}
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={() => { track(EVENTS.DRAFT_ORDER_EDIT_REOPENED); setManualOrder(draftOrder); setDraftOrder([]); }}
                style={{ ...buttonStyle(theme.srf), flex: 1, border: `1px solid ${theme.bdr}`,
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <Pencil size={14} /> Edit
              </button>
              <button onClick={startDraft}
                style={{ ...buttonStyle(theme.grn), flex: 2, padding: 14, fontSize: 16,
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <Rocket size={16} /> Start Draft!
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ===== DRAFT PHASE =====
  // Mobile panel toggle bar
  const panelToggle = isMobile && (
    <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
      {[
        { id: "draft", label: "Draft", Icon: Target },
        { id: "rosters", label: "Rosters", Icon: Users },
        { id: "history", label: "History", Icon: HistoryIcon },
      ].map((p) => (
        <button key={p.id} onClick={() => { track(EVENTS.DRAFT_PANEL_SWITCHED, { panel: p.id }); setMobilePanel(p.id); }}
          style={{
            ...buttonStyle(mobilePanel === p.id ? theme.acc : theme.srf),
            flex: 1, fontSize: 12,
            border: mobilePanel === p.id ? "none" : `1px solid ${theme.bdr}`,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
          }}>
          <p.Icon size={13} /> {p.label}
        </button>
      ))}
    </div>
  );

  // Roster panel content
  const rosterPanel = (
    <div style={{ width: isMobile ? "100%" : 200, flexShrink: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: theme.mut, marginBottom: 8 }}>ROSTERS</div>
      {effective.draftOrder.map((m) => {
        const roster = getRoster(m.id);
        const isOnClock = !isComplete && member && m.id === member.id;
        return (
          <div key={m.id} onClick={() => {
              if (showRoster !== m.id) track(EVENTS.DRAFT_ROSTER_VIEWED, { member_id: m.id });
              setShowRoster(showRoster === m.id ? null : m.id);
            }}
            style={{ ...cardStyle, padding: "10px 12px", marginBottom: 6, cursor: "pointer",
              border: isOnClock ? `2px solid ${MEMBER_COLORS[m.id]}` : `1px solid ${theme.bdr}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: MEMBER_COLORS[m.id] }}>{m.name}</span>
              <span style={{ fontSize: 11, color: theme.dim }}>{roster.length}/15</span>
            </div>
            {showRoster === m.id && roster.length > 0 && (
              <div style={{ marginTop: 8, borderTop: `1px solid ${theme.bdr}`, paddingTop: 8 }}>
                {roster.map((r, i) => (
                  <div key={i} style={{ fontSize: 11, color: theme.mut, marginBottom: 3, display: "flex", gap: 6 }}>
                    <span>{r.category.icon}</span>
                    <span style={{ color: theme.txt }}>{r.pick}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  // History panel content
  const historyPanel = (
    <div style={{ width: isMobile ? "100%" : 200, flexShrink: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: theme.mut, marginBottom: 8 }}>PICK HISTORY</div>
      <div style={{ maxHeight: isMobile ? 400 : "calc(100vh - 200px)", overflowY: "auto" }}>
        {[...effective.pickHistory].reverse().map((h, i) => {
          const mem = effective.draftOrder.find((m) => m.id === h.memberId);
          const cat = DRAFT_CATEGORIES.find((c) => c.id === h.categoryId);
          return (
            <div key={i} style={{ ...cardStyle, padding: "8px 10px", marginBottom: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: theme.dim, marginBottom: 2 }}>
                <span>#{h.pick + 1}</span>
                <span>{cat ? cat.icon : ""} {cat ? cat.name : ""}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: 700, fontSize: 12, color: MEMBER_COLORS[h.memberId] }}>{mem ? mem.name : ""}</span>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{h.selection}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  // Main draft area
  const draftMainArea = (
    <div style={{ flex: 1, minWidth: 0 }}>
      {isComplete ? (
        <div>
          <div style={{ ...cardStyle, textAlign: "center", padding: isMobile ? 20 : 32, marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
              <PartyPopper size={isMobile ? 48 : 60} color={theme.acc} />
            </div>
            <h2 style={{ margin: "0 0 8px", fontSize: isMobile ? 20 : 24 }}>Draft Complete!</h2>
            <p style={{ color: theme.mut, fontSize: 13, marginBottom: 16 }}>
              {effective.draftOrder.length} members · Max base: {effective.draftOrder.length}
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center", marginBottom: 16,
              flexDirection: isMobile ? "column" : "row" }}>
              <label style={{ fontSize: 14, color: theme.mut, fontWeight: 600 }}>Season:</label>
              <input value={seasonName} onChange={(e) => setSeasonName(e.target.value)} disabled={!canControlTimer}
                style={{ ...inputStyle, width: 120, textAlign: "center", fontSize: 18, fontWeight: 700, opacity: canControlTimer ? 1 : 0.6 }} />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
              <button onClick={() => { track(EVENTS.DRAFT_FINALIZE_MODAL_OPENED, { season_name: seasonName }); setShowFinalizeModal(true); }} disabled={!isCommissioner}
                style={{ ...buttonStyle(theme.grn), padding: "12px 24px", fontSize: isMobile ? 13 : 15, opacity: isCommissioner ? 1 : 0.5, cursor: isCommissioner ? "pointer" : "default",
                  display: "flex", alignItems: "center", gap: 8 }}>
                <Trophy size={16} /> Finalize & Launch {seasonName}
              </button>
              <button onClick={exportCSV} style={{ ...buttonStyle(theme.acc), display: "flex", alignItems: "center", gap: 6 }}>
                <Download size={14} /> Export CSV
              </button>
            </div>
            {!isCommissioner && (
              <div style={{ marginTop: 12, fontSize: 12, color: theme.dim }}>
                Commissioner sign-in is required to publish the draft as the new active season.
              </div>
            )}
          </div>

          {/* Finalize confirmation modal */}
          {showFinalizeModal && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
              display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
              <div style={{ ...cardStyle, maxWidth: 500, width: "100%", padding: 24 }}>
                <h3 style={{ margin: "0 0 12px", fontSize: 18, color: theme.red, display: "flex", alignItems: "center", gap: 8 }}>
                  <AlertTriangle size={18} /> Commissioner Authorization
                </h3>
                <div style={{ fontSize: 13, color: theme.mut, lineHeight: 1.7, marginBottom: 16 }}>
                  This will archive the current season and launch <strong>{seasonName}</strong> as the new active season.
                  All {effective.draftOrder.length} members × 15 categories = {effective.draftOrder.length * 15} picks will be saved to Supabase.
                  Scores start at 0. The draft board will be saved for the Recap tab.
                </div>
                <div style={{ ...inputStyle, marginBottom: 8, opacity: 0.7 }}>
                  {commissionerEmail || "Commissioner session required"}
                </div>
                {finalizeError && (
                  <div style={{ fontSize: 12, color: theme.red, marginBottom: 8, padding: 8, borderRadius: 6,
                    background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)" }}>
                    ❌ {finalizeError}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => { setShowFinalizeModal(false); setFinalizeError(""); }}
                    disabled={finalizing}
                    style={{ ...buttonStyle(theme.srf), flex: 1, border: `1px solid ${theme.bdr}` }}>Cancel</button>
                  <button onClick={handleFinalize} disabled={!isCommissioner || finalizing}
                    style={{ ...buttonStyle(theme.red), flex: 2,
                      opacity: isCommissioner && !finalizing ? 1 : 0.5,
                      cursor: isCommissioner && !finalizing ? "pointer" : "default" }}>
                    {finalizing ? "Saving to Supabase..." : "Confirm & Launch"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div>
          {/* On the clock — see DraftCountdown's own comment for why this
              is a separate component rather than inline JSX here. */}
          <DraftCountdown
            liveSession={liveSession}
            clockOffsetRef={clockOffsetRef}
            member={member}
            isMobile={isMobile}
            canControlTimer={canControlTimer}
            currentPick={effective.currentPick}
            pickCount={effective.pickHistory.length}
            timer={timer}
            timerActive={timerActive}
            onPause={handleTimerPause}
            onStart={handleTimerStart}
            onReset={handleTimerReset}
            onUndo={undoPick}
          />

          {/* Category selection — commissioner, local mock, or (now)
              whoever's actually on the clock; a spectator watching
              someone else's turn has nothing to pick */}
          {canPick ? (
            <>
              {!selectedCategory && (
                <div style={cardStyle}>
                  <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>Step 1: Category ({availCats.length} left)</h3>
                  <div style={{ display: "grid",
                    gridTemplateColumns: isMobile ? "repeat(auto-fill, minmax(120px, 1fr))" : "repeat(auto-fill, minmax(150px, 1fr))",
                    gap: 8 }}>
                    {availCats.map((cat) => (
                      <button key={cat.id}
                        onClick={() => { setSelectedCategory(cat); setSearchFilter(""); setCustomInput(""); }}
                        style={{ ...buttonStyle(theme.srf), border: `1px solid ${theme.bdr}`,
                          textAlign: "left", padding: isMobile ? 10 : 12, fontSize: isMobile ? 12 : 13 }}>
                        <span style={{ fontSize: isMobile ? 14 : 18 }}>{cat.icon}</span> {cat.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {selectedCategory && (
                <div style={cardStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <h3 style={{ margin: 0, fontSize: 16 }}>{selectedCategory.icon} {selectedCategory.name}</h3>
                    <button onClick={() => setSelectedCategory(null)}
                      style={{ ...buttonStyle(theme.srf), fontSize: 11, border: `1px solid ${theme.bdr}` }}>← Back</button>
                  </div>
                  <input value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)}
                    placeholder="Search..." style={{ ...inputStyle, marginBottom: 8 }} />
                  <div style={{ maxHeight: isMobile ? 250 : 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                    {(PICK_OPTIONS[selectedCategory.id] || ["Custom..."])
                      .filter((opt) => opt.toLowerCase().includes(searchFilter.toLowerCase()))
                      .filter((opt) => {
                        // Scoped to THIS category's own picks (key suffix
                        // "-<categoryId>"), not every pick anyone has made
                        // in any category. The old check compared against
                        // Object.values(effective.picks) as a whole, so
                        // once any member picked e.g. "Alabama" for NCAAF,
                        // NCAAB's own, independent "Alabama" option — a
                        // real, untaken slot — silently vanished from this
                        // list for the rest of the draft, for every
                        // category that happens to share a name with
                        // another (NCAAF/NCAAB share ~30 school names;
                        // NCAAB/MLS both have "Cincinnati"). Mirrors the
                        // equally-scoped fix in submit_draft_pick's own
                        // selection_already_taken check
                        // (supabase/phase19_draft_pick_rpcs.sql) — that one
                        // is the real, server-enforced gate; this is only
                        // the advisory client-side list, same relationship
                        // as the category_already_picked check just above
                        // it in that file.
                        const suffix = "-" + selectedCategory.id;
                        return !Object.entries(effective.picks).some(
                          ([key, val]) => val === opt && key.endsWith(suffix)
                        );
                      })
                      .map((opt) => {
                        if (opt === "Custom...") {
                          // Live-lookup-eligible categories (DRAFT_LOOKUP_CONFIG)
                          // get a "did you mean" suggestion list below the raw
                          // input — see api/draft-lookup.js's header comment for
                          // why. Picking a suggestion submits ITS canonical
                          // label (isCustom: false, same path as a normal
                          // dropdown option), not whatever was typed; the
                          // input/button above stays exactly as before for
                          // anyone who ignores the suggestions or whose pick
                          // genuinely isn't found.
                          const lookupCfg = DRAFT_LOOKUP_CONFIG[selectedCategory.id];
                          return (
                            <div key="custom">
                              <div style={{ display: "flex", gap: 8 }}>
                                <input value={customInput} onChange={(e) => setCustomInput(e.target.value)}
                                  placeholder="Type custom pick..." style={{ ...inputStyle, flex: 1 }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && customInput.trim()) makePick(selectedCategory.id, customInput.trim(), true);
                                  }} />
                                <button onClick={() => {
                                  if (customInput.trim()) makePick(selectedCategory.id, customInput.trim(), true);
                                }} style={{ ...buttonStyle(theme.grn), padding: "8px 16px" }}>Pick</button>
                              </div>
                              {lookupCfg && customInput.trim() && (
                                <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                                  {customLookupLoading && (
                                    <div style={{ fontSize: 11, color: theme.dim }}>Searching…</div>
                                  )}
                                  {!customLookupLoading && customSuggestions.length === 0 && (
                                    <div style={{ fontSize: 11, color: theme.dim }}>
                                      No matches found — "Pick" will submit "{customInput.trim()}" as typed.
                                    </div>
                                  )}
                                  {customSuggestions.map((s) => (
                                    <button key={s.id} onClick={() => makePick(selectedCategory.id, s.label, false)}
                                      style={{ ...buttonStyle(theme.srf), border: `1px solid ${theme.bdr}`,
                                        textAlign: "left", padding: "6px 10px",
                                        display: "flex", alignItems: "center", gap: 8 }}>
                                      {s.photoUrl && (
                                        <img src={s.photoUrl} alt="" style={{ width: 24, height: 24, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
                                      )}
                                      <span>
                                        <div style={{ fontSize: 12, fontWeight: 600 }}>{s.label}</div>
                                        {s.sublabel && <div style={{ fontSize: 10, color: theme.dim }}>{s.sublabel}</div>}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        }
                        return (
                          <button key={opt} onClick={() => makePick(selectedCategory.id, opt, false)}
                            style={{ ...buttonStyle(theme.srf), border: `1px solid ${theme.bdr}`,
                              textAlign: "left", padding: "8px 12px" }}>
                            {opt}
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={{ ...cardStyle, textAlign: "center", color: theme.dim, fontSize: 13, padding: 20 }}>
              Waiting for {member ? member.name : "the next member"} to pick...
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: isMobile ? 17 : 20, display: "flex", alignItems: "center", gap: 8 }}>
          <Target size={isMobile ? 17 : 20} /> {headerSeasonLabel} Draft
          {liveSession && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 800,
              color: theme.red, border: `1px solid ${theme.red}`, borderRadius: 999, padding: "2px 8px",
              textTransform: "uppercase", letterSpacing: 0.5 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: theme.red }} /> Live
            </span>
          )}
        </h2>
        <div style={{ display: "flex", gap: 8 }}>
          {liveSession && isCommissioner && (
            <button onClick={() => setShowCancelModal(true)}
              style={{ ...buttonStyle(theme.srf), fontSize: 11, border: `1px solid ${theme.bdr}`, color: theme.red,
                display: "flex", alignItems: "center", gap: 5 }}>
              <XCircle size={13} /> Cancel Draft
            </button>
          )}
          {!isMobile && (
            <button onClick={() => { track(EVENTS.DRAFT_HISTORY_PANEL_TOGGLED, { is_visible: !showHistory }); setShowHistory(!showHistory); }}
              style={{ ...buttonStyle(theme.srf), fontSize: 11, border: `1px solid ${theme.bdr}` }}>
              {showHistory ? "Hide History" : "History"}
            </button>
          )}
        </div>
      </div>

      {nonCommissionerBanner}
      {spectatorBanner}
      {yourTurnBanner}
      {pickErrorBanner}

      {/* Cancel-draft confirmation modal */}
      {showCancelModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
          <div style={{ ...cardStyle, maxWidth: 440, width: "100%", padding: 24 }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 18, color: theme.red, display: "flex", alignItems: "center", gap: 8 }}>
              <AlertTriangle size={18} /> Cancel this live draft?
            </h3>
            <div style={{ fontSize: 13, color: theme.mut, lineHeight: 1.7, marginBottom: 16 }}>
              Everyone watching will lose the live draft — picks made so far are not saved anywhere else.
              You'll start over from setup.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setShowCancelModal(false)} disabled={cancelling}
                style={{ ...buttonStyle(theme.srf), flex: 1, border: `1px solid ${theme.bdr}`,
                  opacity: cancelling ? 0.5 : 1, cursor: cancelling ? "default" : "pointer" }}>Keep drafting</button>
              <button onClick={cancelDraft} disabled={cancelling}
                style={{ ...buttonStyle(theme.red), flex: 2,
                  opacity: cancelling ? 0.7 : 1, cursor: cancelling ? "default" : "pointer" }}>
                {cancelling ? "Cancelling..." : "Cancel draft"}
              </button>
            </div>
          </div>
        </div>
      )}

      {panelToggle}

      {isMobile ? (
        <div>
          {mobilePanel === "draft" && draftMainArea}
          {mobilePanel === "rosters" && rosterPanel}
          {mobilePanel === "history" && historyPanel}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 16 }}>
          {rosterPanel}
          {draftMainArea}
          {showHistory && historyPanel}
        </div>
      )}

      {/* Draft Board */}
      <div style={{ marginTop: 16, ...cardStyle, overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 16, display: "flex", alignItems: "center", gap: 6 }}>
          <BarChart3 size={16} /> Draft Board
        </h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: isMobile ? 10 : 11 }}>
          <thead>
            <tr>
              <th style={{ padding: isMobile ? "4px 6px" : "6px 8px", textAlign: "left", color: theme.mut,
                borderBottom: `1px solid ${theme.bdr}`, position: "sticky", left: 0,
                background: theme.card, zIndex: 2, fontSize: isMobile ? 9 : 11 }}>Category</th>
              {effective.draftOrder.map((m) => (
                <th key={m.id} style={{ padding: isMobile ? "4px 4px" : "6px 8px", textAlign: "center",
                  color: MEMBER_COLORS[m.id], borderBottom: `1px solid ${theme.bdr}`,
                  fontWeight: 700, minWidth: isMobile ? 60 : 80, fontSize: isMobile ? 9 : 11 }}>
                  {isMobile ? m.name.slice(0, 4) : m.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DRAFT_CATEGORIES.map((cat) => (
              <tr key={cat.id}>
                <td style={{ padding: isMobile ? "4px 6px" : "6px 8px", borderBottom: `1px solid ${theme.bdr}`,
                  color: theme.mut, fontWeight: 600, position: "sticky", left: 0,
                  background: theme.card, whiteSpace: "nowrap", zIndex: 1, fontSize: isMobile ? 9 : 11 }}>
                  {cat.icon} {isMobile ? cat.name.slice(0, 8) : cat.name}
                </td>
                {effective.draftOrder.map((m) => {
                  const v = effective.picks[m.id + "-" + cat.id];
                  return (
                    <td key={m.id} style={{ padding: isMobile ? "4px 4px" : "6px 8px",
                      borderBottom: `1px solid ${theme.bdr}`,
                      textAlign: "center", color: v ? theme.txt : theme.dim,
                      fontWeight: v ? 600 : 400,
                      background: v ? MEMBER_COLORS[m.id] + "10" : "transparent",
                      fontSize: isMobile ? 9 : (v ? 11 : 10) }}>
                      {v || "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
