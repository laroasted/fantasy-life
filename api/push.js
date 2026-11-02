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
const { sendPushToAllSubscribers, isAllowedPushEndpoint } = require('./_lib/push');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function handleSubscribe(req, res, supabase) {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription payload' });
  }
  if (!isAllowedPushEndpoint(endpoint)) {
    return res.status(400).json({ error: 'Unrecognized push endpoint' });
  }
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

async function handleTest(req, res, supabase) {
  const result = await sendPushToAllSubscribers(supabase, {
    title: 'Fantasy Life',
    body: 'Test notification — if you can see this, push is working.',
  });
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
    case 'test': return handleTest(req, res, supabase);
    default: return res.status(404).json({ error: 'Unknown push action' });
  }
};
