// Shared Web Push sender, used by api/push/*.js and any cron that wants
// to notify subscribers (currently just api/cron/update-sports.js).
// Lives under api/_lib/ — Vercel skips underscore-prefixed paths when
// turning api/** into routes, so this stays an internal module, not an
// endpoint.
const webpush = require('web-push');

// Known Web Push service hosts (Chrome/Edge/Samsung via FCM, Firefox,
// Safari, legacy Edge/WNS). api/push/subscribe.js is unauthenticated by
// design (see its own comment), so without this allowlist anyone could
// POST an arbitrary endpoint URL and have it stored — then
// sendPushToAllSubscribers() would dutifully make an outbound request to
// that attacker-chosen URL on every cron run. Restricting to real push
// services closes that off.
const ALLOWED_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
];

function isAllowedPushEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') return false;
    return ALLOWED_PUSH_HOSTS.some(
      (host) => url.hostname === host || url.hostname.endsWith('.' + host)
    );
  } catch {
    return false;
  }
}

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  const publicKey = process.env.REACT_APP_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    console.warn('Push: VAPID env vars not fully set, skipping send.');
    return false;
  }
  // setVapidDetails throws synchronously on a malformed value (e.g.
  // VAPID_SUBJECT missing its required mailto:/https: prefix) — a
  // misconfigured env var must degrade to "no push sent", never bubble up
  // and fail whatever cron called sendPushToAllSubscribers() after it had
  // already done its real work.
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  } catch (err) {
    console.error('Push: invalid VAPID configuration, skipping send:', err.message);
    return false;
  }
  configured = true;
  return true;
}

// Shared core: loads whichever subscriptions `scope` selects, sends the
// payload to each, and cleans up any the push service reports as gone.
// `scope` is one of:
//   {} — every subscription (the manual test trigger, and anyone who's
//        never claimed a member identity)
//   { memberId } — only that member's device(s)
//   { unclaimedOnly: true } — only subscriptions with no member_id, i.e.
//        the broad digest's audience once claimed members get targeted
//        pushes instead (see sendPushToMember / AGENTS.md's push section)
async function sendPush(supabase, { title, body, url = '/' }, scope = {}) {
  // `reason` is set ONLY on these early, zero-subscription-reached exits
  // — Codex-caught, real: without it, a misconfigured VAPID setup or a
  // failed subscription-lookup query return the exact same {sent: 0,
  // failed: 0} shape as "this member genuinely has no subscription",
  // which the commissioner-facing test tool (SeasonSettings.jsx) used to
  // report as the latter unconditionally, pointing them at the wrong
  // fix. The normal success path below returns {sent, failed} with no
  // `reason` at all, so this is additive — nothing downstream that
  // already just reads sent/failed needs to change.
  if (!ensureConfigured()) return { sent: 0, failed: 0, reason: 'not_configured' };

  let query = supabase.from('push_subscriptions').select('id, endpoint, p256dh, auth');
  if (scope.memberId) query = query.eq('member_id', scope.memberId);
  else if (scope.unclaimedOnly) query = query.is('member_id', null);

  const { data: subs, error } = await query;
  if (error) {
    console.error('Push: failed to load subscriptions:', error.message);
    return { sent: 0, failed: 0, reason: 'lookup_failed' };
  }
  if (!subs || subs.length === 0) return { sent: 0, failed: 0, reason: 'no_subscriptions' };

  const payload = JSON.stringify({ title, body, data: { url } });
  let sent = 0;
  let failed = 0;
  const staleIds = [];

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 404 || err.statusCode === 410) {
        staleIds.push(sub.id);
      } else {
        console.error(`Push: failed to send to subscription ${sub.id}:`, err.message);
      }
    }
  }));

  if (staleIds.length > 0) {
    const { error: delErr } = await supabase.from('push_subscriptions').delete().in('id', staleIds);
    if (delErr) console.error('Push: failed to clean up expired subscriptions:', delErr.message);
    else console.log(`Push: removed ${staleIds.length} expired subscription(s)`);
  }

  console.log(`Push: sent ${sent}, failed ${failed - staleIds.length}, expired ${staleIds.length}`);
  return { sent, failed };
}

// Literally everyone — used by the manual ?action=test trigger, which
// should reach every subscription regardless of claim status.
async function sendPushToAllSubscribers(supabase, payload) {
  return sendPush(supabase, payload);
}

// Only the given member's device(s) — see AGENTS.md's push section:
// once a member has claimed an identity, this replaces the broad digest
// for them rather than adding to it.
async function sendPushToMember(supabase, memberId, payload) {
  if (!memberId) return { sent: 0, failed: 0 };
  return sendPush(supabase, payload, { memberId });
}

// Everyone who hasn't claimed a member identity yet — the broad digest's
// actual audience now that claimed members get sendPushToMember() instead.
async function sendPushToUnclaimedSubscribers(supabase, payload) {
  return sendPush(supabase, payload, { unclaimedOnly: true });
}

// Deep-links into the exact category the notification is about, reusing
// the same `cat` URL param Scoreboard.jsx already reads on mount and
// keeps in sync (see its own `selCat` effect) — no new wiring needed on
// the frontend side, just pointing the push at a URL it already handles.
// Moved here from update-sports.js (originally the only caller) so every
// cron that writes score_events can share one copy instead of each
// re-implementing it.
function scoreboardUrl(category) {
  const params = new URLSearchParams({ tab: 'scoreboard' });
  if (category) params.set('cat', category);
  return `/?${params.toString()}`;
}

// title carries the actual message, not the app name: Safari/iOS already
// shows "from Fantasy Life" as a platform-level second line on every web
// push notification (not something the Notification API can suppress),
// so a literal "Fantasy Life" title just duplicated it. Putting the real
// content in title instead removes that redundancy and is more useful.
//
// `targeted`: true when every event in `scoreEvents` belongs to the same
// member (writeScoreEventsAndNotify's per-member loop, below) — lets the
// multi-event case name each category instead of falling back to a bare
// count, since there's one specific person to be specific for. The broad
// digest (unclaimed subscribers, potentially many different members in
// one `scoreEvents` batch) leaves `targeted` unset and keeps the generic
// count — there's no single person to deep-link it to.
function buildScoreDigest(scoreEvents, memberNameById, { targeted = false } = {}) {
  if (scoreEvents.length === 0) return null;
  if (scoreEvents.length === 1) {
    const e = scoreEvents[0];
    const name = memberNameById[e.member_id] || e.member_id;
    const sign = e.delta > 0 ? '+' : '';
    return {
      title: `${name} ${sign}${e.delta} in ${e.category}`,
      body: e.cause || 'Scoreboard updated',
      url: scoreboardUrl(e.category),
    };
  }
  if (targeted) {
    const name = memberNameById[scoreEvents[0].member_id] || scoreEvents[0].member_id;
    // Country is the one category with two independent scoring mechanisms
    // (GDP rank + Olympic medal count), so a single run can produce more
    // than one event for the same member in the same category — every
    // other cron writes at most one event per member per run, so until
    // Country this branch only ever saw one event per distinct category.
    // Name the actual category instead of claiming "N categories" when
    // they're all the same one, and use each event's own cause text
    // (not a repeated "Country +3 · Country +7") so the two sub-events
    // stay distinguishable.
    const categories = new Set(scoreEvents.map((e) => e.category));
    if (categories.size === 1) {
      const [category] = categories;
      const body = scoreEvents
        .map((e) => e.cause || `${e.delta > 0 ? '+' : ''}${e.delta}`)
        .join(' · ');
      return { title: `${name}: ${category} updated`, body, url: scoreboardUrl(category) };
    }
    const parts = scoreEvents.map((e) => {
      const sign = e.delta > 0 ? '+' : '';
      return `${e.category} ${sign}${e.delta}`;
    });
    return {
      title: `${name}: ${scoreEvents.length} categories updated`,
      body: parts.join(' · '),
      url: scoreboardUrl(),
    };
  }
  return {
    title: `${scoreEvents.length} score updates`,
    body: 'Tap to see what changed.',
    url: scoreboardUrl(),
  };
}

// Shared by every cron that diffs picks and wants the activity feed +
// push layer for free: batch-inserts `scoreEvents` into score_events,
// then sends the broad "N score updates" digest to unclaimed subscribers
// and one targeted, per-member digest to each member whose own score
// moved this run (grouped so a member with changes in two categories in
// the same run still gets exactly one push, not two). A no-op if
// scoreEvents is empty, so callers don't need their own length check
// first. Every failure here (the insert, or any individual send) is
// logged and swallowed, never thrown — the activity feed/push layer is
// additive on top of real scoring (already written by the caller before
// this is called), never allowed to fail the cron's own response.
async function writeScoreEventsAndNotify(supabase, scoreEvents, memberNameById) {
  if (!scoreEvents || scoreEvents.length === 0) return;

  const { error: eventsErr } = await supabase.from('score_events').insert(scoreEvents);
  if (eventsErr) console.error(`Failed to write score_events: ${eventsErr.message}`);
  else console.log(`Wrote ${scoreEvents.length} score_events rows`);

  const digest = buildScoreDigest(scoreEvents, memberNameById);
  if (digest) {
    try {
      await sendPushToUnclaimedSubscribers(supabase, digest);
    } catch (pushErr) {
      console.error('Push: broad digest send failed:', pushErr.message);
    }
  }

  const eventsByMember = {};
  scoreEvents.forEach((e) => {
    (eventsByMember[e.member_id] = eventsByMember[e.member_id] || []).push(e);
  });
  for (const [memberId, memberEvents] of Object.entries(eventsByMember)) {
    const memberDigest = buildScoreDigest(memberEvents, memberNameById, { targeted: true });
    if (!memberDigest) continue;
    try {
      await sendPushToMember(supabase, memberId, memberDigest);
    } catch (pushErr) {
      console.error(`Push: targeted send to ${memberId} failed:`, pushErr.message);
    }
  }
}

module.exports = {
  sendPushToAllSubscribers,
  sendPushToMember,
  sendPushToUnclaimedSubscribers,
  isAllowedPushEndpoint,
  scoreboardUrl,
  buildScoreDigest,
  writeScoreEventsAndNotify,
};
