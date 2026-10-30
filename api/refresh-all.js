/**
 * Fantasy Life — Manual "Refresh" dispatcher
 *
 * Triggered by the Refresh button in the header. Runs every data-updating
 * cron job (sports, college, stocks, entertainment, billboard, events,
 * country) concurrently, then snapshot-scores, so a visitor can force a
 * live update instead of waiting for the next scheduled run.
 *
 * update-projections is DELIBERATELY NOT chained in here. It was, briefly
 * (see PR #16 history) — caught via a live timeout against a real deploy:
 * this function already runs close to its own maxDuration just on the 7
 * data jobs (Billboard scraping and the per-film TMDB/OMDB calls in
 * entertainment are both documented as able to run long), and stacking
 * projections' own up-to-40s external-call budget on top of that blew
 * straight through the ceiling. Projections stays on its own independent
 * daily cron schedule (vercel.json), where it gets the full function
 * timeout to itself instead of sharing it with 8 other jobs.
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
 * maxDuration is 120s (vercel.json), not Vercel's old 60s-ish ceiling —
 * confirmed live (PR #16): this file's own dynamic-require() bug (fixed
 * above) meant every job here had ALWAYS failed instantly with "Cannot
 * find module" on production, which masked whether 60s was actually
 * enough for genuine execution. The very first real run after that fix
 * landed hit a 504 FUNCTION_INVOCATION_TIMEOUT at 60s — Billboard's
 * retry/backoff (see update-billboard.js) can genuinely run long. Per
 * Vercel's own current docs, Hobby already allows up to 300s, so 120s
 * is a conservative bump with real headroom, not a plan-tier risk.
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

// Required statically, by literal path, not via a runtime variable passed
// to require(). Vercel's build-time bundler (@vercel/nft) traces literal
// require() calls to decide which files get packaged into this function's
// deployment — it can't trace `require(someVariable)`, so a dynamic path
// here silently produces a function bundle missing api/cron/*.js entirely
// ("Cannot find module './cron/update-sports'" at runtime). This bit
// every job here, not just new ones, until it was caught against a real
// deploy — see PR #16.
const updateSports = require('./cron/update-sports');
const updateCollege = require('./cron/update-college');
const updateStocks = require('./cron/update-stocks');
const updateEntertainment = require('./cron/update-entertainment');
const updateBillboard = require('./cron/update-billboard');
const updateEvents = require('./cron/update-events');
const updateCountry = require('./cron/update-country');
const snapshotScores = require('./cron/snapshot-scores');

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

async function runJob(name, jobHandler) {
  var startedAt = Date.now();
  try {
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
  ['sports', updateSports],
  ['college', updateCollege],
  ['stocks', updateStocks],
  ['entertainment', updateEntertainment],
  ['billboard', updateBillboard],
  ['events', updateEvents],
  ['country', updateCountry],
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
  var snapshotResult = await runJob('snapshot-scores', snapshotScores);

  var jobs = dataResults.concat([snapshotResult]);
  var allOk = jobs.every(function (j) { return j.ok; });

  return res.status(200).json({
    success: allOk,
    skipped: false,
    message: allOk ? 'All jobs completed' : 'Some jobs failed — see jobs[] for details',
    timestamp: new Date().toISOString(),
    jobs: jobs,
  });
};
