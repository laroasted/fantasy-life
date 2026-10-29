/**
 * Fantasy Life — Manual "Refresh" dispatcher
 *
 * Triggered by the Refresh button in the header. Runs every data-updating
 * cron job (sports, college, stocks, entertainment, billboard, events,
 * country) concurrently, then snapshot-scores, then update-projections
 * once they're done, so a visitor can force a live update instead of
 * waiting for the next scheduled run.
 *
 * Calls each cron module's handler directly in-process (no HTTP hop) with
 * a fake req/res pair, reusing the same CRON_SECRET auth each job already
 * checks for itself — this endpoint doesn't bypass that, it just supplies
 * it internally.
 *
 * No auth on this endpoint itself: regular visitors are expected to use
 * it, same as the cron jobs it wraps are expected to run on a schedule.
 *
 * Each job is awaited to GENUINE completion before snapshot-scores runs —
 * an earlier version raced each job against a per-job timeout and moved on
 * regardless, but that let a timed-out job's write (billboard scraping has
 * retries/backoff and can run long) land after snapshot-scores had already
 * read the picks table, recording a stale pre-update total as that day's
 * trend point. Vercel's own function maxDuration (see vercel.json) is the
 * only timeout that applies here now; if something genuinely hangs, the
 * whole function is killed rather than silently snapshotting half-updated
 * data.
 *
 * Open to anyone, with a cooldown instead of an auth gate: a repeat-click
 * or a bot hammering this endpoint would otherwise re-trigger every
 * external API call and Supabase write on every request. claimRefreshSlot()
 * does a single atomic UPDATE ... WHERE last_full_refresh_at is old enough
 * (or null), so only the request that actually flips the timestamp — not
 * every request that merely reads it as stale — proceeds to run the jobs;
 * everyone else gets told a refresh ran recently and skips straight to
 * re-reading whatever's already there.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const COOLDOWN_MS = 2 * 60 * 1000;

// Fails OPEN (lets the refresh proceed) on any cooldown-check problem —
// missing key, network error, whatever — rather than ever letting a
// Supabase hiccup silently and permanently disable the Refresh button.
async function claimRefreshSlot() {
  if (!SUPABASE_SERVICE_KEY) return { claimed: true };
  try {
    var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    var thresholdIso = new Date(Date.now() - COOLDOWN_MS).toISOString();
    var { data, error } = await supabase
      .from('seasons')
      .update({ last_full_refresh_at: new Date().toISOString() })
      .eq('status', 'active')
      .or('last_full_refresh_at.is.null,last_full_refresh_at.lt.' + thresholdIso)
      .select('year');
    if (error) {
      console.error('refresh-all: cooldown check failed, proceeding without it:', error.message);
      return { claimed: true };
    }
    return { claimed: !!(data && data.length > 0) };
  } catch (e) {
    console.error('refresh-all: cooldown check threw, proceeding without it:', e.message);
    return { claimed: true };
  }
}

async function runJob(name, modulePath) {
  var startedAt = Date.now();
  try {
    var jobHandler = require(modulePath);
    var fakeReq = { method: 'POST', headers: { authorization: 'Bearer ' + (CRON_SECRET || '') } };
    var captured = { statusCode: 200, body: null };
    var fakeRes = {
      status: function (code) { captured.statusCode = code; return fakeRes; },
      json: function (body) { captured.body = body; return fakeRes; },
    };
    await jobHandler(fakeReq, fakeRes);
    return { name: name, ok: captured.statusCode < 400, status: captured.statusCode, body: captured.body, ms: Date.now() - startedAt };
  } catch (e) {
    return { name: name, ok: false, status: 'error', error: e.message, ms: Date.now() - startedAt };
  }
}

const DATA_JOBS = [
  ['sports', './cron/update-sports'],
  ['college', './cron/update-college'],
  ['stocks', './cron/update-stocks'],
  ['entertainment', './cron/update-entertainment'],
  ['billboard', './cron/update-billboard'],
  ['events', './cron/update-events'],
  ['country', './cron/update-country'],
];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed, use POST' });

  var slot = await claimRefreshSlot();
  if (!slot.claimed) {
    return res.status(200).json({
      success: true,
      skipped: true,
      message: 'A full refresh already ran recently — skipped to avoid hammering external APIs.',
      timestamp: new Date().toISOString(),
      jobs: [],
    });
  }

  // These seven are independent of each other and are the bulk of the
  // external-API wait time, so they run concurrently. snapshot-scores is
  // run separately, after they've all settled: it records the picks
  // table's state at the moment it runs, so it has to come strictly after
  // a score update, or it risks snapshotting stale pre-update numbers (see
  // that file's own header comment).
  var dataResults = await Promise.all(
    DATA_JOBS.map(function (job) { return runJob(job[0], job[1]); })
  );
  var snapshotResult = await runJob('snapshot-scores', './cron/snapshot-scores');
  // Projections read `picks` for their current-value baseline, same as
  // snapshot-scores — must run after the data jobs have actually written,
  // not concurrently with them.
  var projectionsResult = await runJob('projections', './cron/update-projections');

  var jobs = dataResults.concat([snapshotResult, projectionsResult]);
  var allOk = jobs.every(function (j) { return j.ok; });

  return res.status(200).json({
    success: allOk,
    skipped: false,
    message: allOk ? 'All jobs completed' : 'Some jobs failed — see jobs[] for details',
    timestamp: new Date().toISOString(),
    jobs: jobs,
  });
};
