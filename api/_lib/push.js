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

// Sends one notification to every stored subscription. A subscription the
// push service reports as gone (410, or 404 — some services use either)
// is deleted so push_subscriptions doesn't accumulate dead rows forever;
// any other per-subscription failure is logged and skipped, same
// "additive, never blocks the real write" stance as score_events.
async function sendPushToAllSubscribers(supabase, { title, body, url = '/' }) {
  if (!ensureConfigured()) return { sent: 0, failed: 0 };

  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth');
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

module.exports = { sendPushToAllSubscribers, isAllowedPushEndpoint };
