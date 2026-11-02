// Manual test trigger — sends a canned notification to every current
// subscriber, bypassing the real score-delta path in
// api/cron/update-sports.js entirely. Exists purely so push delivery can
// be verified on demand without waiting for real sports data to move or
// for the daily cron (see AGENTS.md's "Push notifications" section for
// the real send path). Gated behind CRON_SECRET, same as the crons —
// unlike subscribe.js/unsubscribe.js this isn't meant for regular
// visitors to hit.
const { createClient } = require('@supabase/supabase-js');
const { sendPushToAllSubscribers } = require('../_lib/push');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const result = await sendPushToAllSubscribers(supabase, {
    title: 'Fantasy Life',
    body: 'Test notification — if you can see this, push is working.',
  });
  return res.status(200).json(result);
};
