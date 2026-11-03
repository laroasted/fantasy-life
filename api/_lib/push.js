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
  if (!ensureConfigured()) return { sent: 0, failed: 0 };

  let query = supabase.from('push_subscriptions').select('id, endpoint, p256dh, auth');
  if (scope.memberId) query = query.eq('member_id', scope.memberId);
  else if (scope.unclaimedOnly) query = query.is('member_id', null);

  const { data: subs, error } = await query;
  if (error) {
    console.error('Push: failed to load subscriptions:', error.message);
    return { sent: 0, failed: 0 };
  }
  if (!subs || subs.length === 0) return { sent: 0, failed: 0 };

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

module.exports = {
  sendPushToAllSubscribers,
  sendPushToMember,
  sendPushToUnclaimedSubscribers,
  isAllowedPushEndpoint,
};
