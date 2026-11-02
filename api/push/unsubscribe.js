// Removes a browser's push subscription. Called by src/utils/push.js
// right after pushManager subscription.unsubscribe() succeeds, so a
// visitor who turns notifications off stops getting them even though
// their old subscription object is now locally invalid anyway — this is
// what keeps push_subscriptions from accumulating rows for people who
// opted back out.
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed, use POST' });
  }
  if (!SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });
  }

  const { endpoint } = req.body || {};
  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) {
    console.error('push/unsubscribe: delete failed:', error.message);
    return res.status(500).json({ error: 'Failed to remove subscription' });
  }
  return res.status(200).json({ ok: true });
};
