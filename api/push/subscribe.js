// Saves a browser's push subscription. Called by src/utils/push.js right
// after registration.pushManager.subscribe() succeeds. No auth on this
// endpoint itself — same stance as api/refresh-all.js: regular visitors
// are expected to call it directly.
const { createClient } = require('@supabase/supabase-js');
const { isAllowedPushEndpoint } = require('../_lib/push');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed, use POST' });
  }
  if (!SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });
  }

  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription payload' });
  }
  if (!isAllowedPushEndpoint(endpoint)) {
    return res.status(400).json({ error: 'Unrecognized push endpoint' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      { endpoint, p256dh: keys.p256dh, auth: keys.auth, user_agent: req.headers['user-agent'] || null },
      { onConflict: 'endpoint' }
    );

  if (error) {
    console.error('push/subscribe: upsert failed:', error.message);
    return res.status(500).json({ error: 'Failed to save subscription' });
  }
  return res.status(200).json({ ok: true });
};
