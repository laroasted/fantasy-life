// Consolidated push endpoint — handles subscribe, unsubscribe, and the
// manual test trigger as ONE Vercel Serverless Function instead of
// three, dispatched by an ?action= query param (req.query.action)
// rather than a URL path segment.
//
// Why one function: the Hobby plan caps a deployment at 12 Serverless
// Functions total. This repo was already at exactly 12 (api/refresh-all.js
// + the 9 api/cron/*.js jobs + two push routes) before a third push file
// pushed it to 13 and broke every deployment.
//
// Why a flat file + query param, not api/push/[action].js: tried that
// first — it builds fine (still just one function) but never actually
// routes in production here. A request to /api/push/test fell through
// to the static SPA catch-all instead of reaching this file, 405'ing as
// a GET/POST against index.html. api/refresh-all.js and every
// api/cron/*.js file are flat, non-nested, bracket-free names and all
// route correctly, so this mirrors that proven pattern instead of
// relying on dynamic-segment routing this project's config doesn't
// seem to support. Callers now hit /api/push?action=subscribe,
// ?action=unsubscribe, ?action=test.
const { createClient } = require('@supabase/supabase-js');
const { sendPushToAllSubscribers, sendPushToMember, isAllowedPushEndpoint } = require('./_lib/push');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
// Same publishable/anon key storage.js ships to every visitor's browser
// bundle — safe to hold here too, since it's not a secret. Used only to
// build a throwaway client scoped to the CALLER's own JWT (below), so
// is_commissioner() evaluates against who's actually asking, the same
// way it would from a direct browser call.
const SUPABASE_ANON_KEY = 'sb_publishable_9lGdGZ1EEifhWZlPRQa-WA_QVbPD6O6';

async function handleSubscribe(req, res, supabase) {
  const { endpoint, keys, memberId } = req.body || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription payload' });
  }
  if (!isAllowedPushEndpoint(endpoint)) {
    return res.status(400).json({ error: 'Unrecognized push endpoint' });
  }
  // The browser always sends its current claimed identity (or null if
  // unclaimed) on every subscribe call — see subscribeToPush() — so this
  // upsert correctly reflects the live state each time, including
  // clearing a stale member_id if someone ever un-claims. The FK on
  // push_subscriptions.member_id only ever sees ids the claim RPC has
  // already validated against the members table, so no extra check here.
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        user_agent: req.headers['user-agent'] || null,
        member_id: typeof memberId === 'string' && memberId ? memberId : null,
      },
      { onConflict: 'endpoint' }
    );
  if (error) {
    console.error('push/subscribe: upsert failed:', error.message);
    return res.status(500).json({ error: 'Failed to save subscription' });
  }
  return res.status(200).json({ ok: true });
}

async function handleUnsubscribe(req, res, supabase) {
  const { endpoint } = req.body || {};
  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint' });
  }
  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) {
    console.error('push/unsubscribe: delete failed:', error.message);
    return res.status(500).json({ error: 'Failed to remove subscription' });
  }
  return res.status(200).json({ ok: true });
}

// Pushes whoever is currently on the clock in the live draft — called by
// DraftTool.jsx right after a pick lands (self-service or commissioner-
// override), reusing the exact sendPushToMember() primitive the sports
// cron already uses for score alerts. Deliberately takes NO memberId (or
// anything else) from the request body: unlike subscribe/unsubscribe,
// where the caller only ever affects its OWN endpoint, an open "push
// this memberId" endpoint would let anyone who knows a member id (public
// — it's in the app's own UI) spam that person's phone on demand. Instead
// this reads draft_sessions itself (service role, same client as every
// other action here) and derives the target from the server's own
// current_pick/snake_order — the caller can trigger a check, never choose
// who gets pushed. The updated_at freshness check on top of that caps
// WHEN a call can do anything to "within 15s of a real state change" —
// but on its own that only bounds the window, not how many calls land
// inside it (Codex-caught, real finding: a repeated or concurrent call
// within that window would otherwise send another duplicate push every
// time). last_notified_pick (phase19_draft_pick_rpcs.sql) closes that:
// the UPDATE below only succeeds for the ONE caller that actually flips
// it from its previous value to the current pick number — the same
// optimistic-concurrency idiom submit_draft_pick uses for current_pick
// itself. Every other call (repeated, racing, or just late) updates 0
// rows and skips sending, so a given turn can ever cause one push.
async function handleNotifyTurn(req, res, supabase) {
  const { data: session, error } = await supabase
    .from('draft_sessions')
    .select('snake_order, current_pick, status, updated_at, last_notified_pick')
    .eq('id', 1)
    .maybeSingle();
  if (error || !session || session.status === 'complete') {
    return res.status(200).json({ ok: true, skipped: 'no_live_draft' });
  }
  const updatedMs = new Date(session.updated_at).getTime();
  if (!Number.isFinite(updatedMs) || Date.now() - updatedMs > 15000) {
    return res.status(200).json({ ok: true, skipped: 'stale' });
  }
  const onClock = session.snake_order && session.snake_order[session.current_pick];
  const memberId = onClock && onClock.memberId;
  if (!memberId) {
    return res.status(200).json({ ok: true, skipped: 'no_one_on_clock' });
  }
  if (session.last_notified_pick === session.current_pick) {
    return res.status(200).json({ ok: true, skipped: 'already_notified' });
  }

  let claim = supabase
    .from('draft_sessions')
    .update({ last_notified_pick: session.current_pick })
    .eq('id', 1)
    .eq('current_pick', session.current_pick);
  claim = session.last_notified_pick === null
    ? claim.is('last_notified_pick', null)
    : claim.eq('last_notified_pick', session.last_notified_pick);
  const { data: claimed, error: claimErr } = await claim.select('id');
  if (claimErr) {
    console.error('push/notify-turn: claim failed:', claimErr.message);
    return res.status(200).json({ ok: true, skipped: 'claim_error' });
  }
  if (!claimed || claimed.length === 0) {
    // Someone else's call (or an earlier one of this same caller's own
    // retries) already claimed this turn's notification first.
    return res.status(200).json({ ok: true, skipped: 'already_claimed' });
  }

  const result = await sendPushToMember(supabase, memberId, {
    title: "You're on the clock!",
    body: "It's your turn to pick in the Fantasy Life draft.",
    url: '/?tab=draft',
  });
  return res.status(200).json(result);
}

// Commissioner-only, browser-facing test push — the Settings UI's "send
// a test notification to this member" button (SeasonSettings.jsx's push
// tab). Distinct from ?action=test (above/below): that one is gated by
// CRON_SECRET, a static server-only secret a browser could never hold;
// this one is gated by asking Supabase itself whether the CALLER's own
// session is a commissioner, the same is_commissioner() check every
// other commissioner-only write in this app goes through — just asked
// from a Vercel function instead of directly from the browser, since
// sending a push has to happen server-side (VAPID_PRIVATE_KEY).
async function handleTestMember(req, res, supabase) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: isCommish, error: commishErr } = await callerClient.rpc('is_commissioner');
  if (commishErr || !isCommish) {
    return res.status(403).json({ error: 'Commissioner only' });
  }

  const { memberId } = req.body || {};
  if (!memberId || typeof memberId !== 'string') {
    return res.status(400).json({ error: 'Missing memberId' });
  }

  const result = await sendPushToMember(supabase, memberId, {
    title: 'Test notification',
    body: `Sent from Settings at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
    url: '/',
  });
  return res.status(200).json(result);
}

async function handleTest(req, res, supabase) {
  // title carries the real content, not the app name — Safari/iOS already
  // shows "from Fantasy Life" as its own platform-level second line on
  // every web push notification, so a literal "Fantasy Life" title here
  // would just duplicate it.
  const { memberId } = req.body || {};
  const payload = {
    title: memberId ? `Test notification for ${memberId}` : 'Test notification',
    body: 'If you can see this, push is working.',
  };
  // Optional memberId lets you verify the targeted-push path (phase12)
  // on demand instead of waiting for a real score change to exercise it
  // — same gating as the broadcast test (CRON_SECRET bearer token below),
  // nothing new to secure here.
  const result = memberId
    ? await sendPushToMember(supabase, memberId, payload)
    : await sendPushToAllSubscribers(supabase, payload);
  return res.status(200).json(result);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed, use POST' });
  }

  const { action } = req.query;

  // Checked before the shared SUPABASE_SERVICE_KEY check (not after) so
  // an unauthenticated caller to the privileged test action always sees
  // a plain 401, never a 500 that leaks env config state.
  if (action === 'test') {
    const authHeader = req.headers['authorization'];
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  switch (action) {
    case 'subscribe': return handleSubscribe(req, res, supabase);
    case 'unsubscribe': return handleUnsubscribe(req, res, supabase);
    case 'notify-turn': return handleNotifyTurn(req, res, supabase);
    case 'test-member': return handleTestMember(req, res, supabase);
    case 'test': return handleTest(req, res, supabase);
    default: return res.status(404).json({ error: 'Unknown push action' });
  }
};
