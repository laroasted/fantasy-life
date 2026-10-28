/**
 * Fantasy Life — Manual "Refresh" dispatcher
 *
 * Triggered by the Refresh button in the header. Runs every data-updating
 * cron job (sports, college, stocks, entertainment, billboard, events,
 * country) concurrently, then snapshot-scores once they're done, so a
 * visitor can force a live update instead of waiting for the next
 * scheduled run.
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
 */

const CRON_SECRET = process.env.CRON_SECRET;

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

  var jobs = dataResults.concat([snapshotResult]);
  var allOk = jobs.every(function (j) { return j.ok; });

  return res.status(200).json({
    success: allOk,
    message: allOk ? 'All jobs completed' : 'Some jobs failed — see jobs[] for details',
    timestamp: new Date().toISOString(),
    jobs: jobs,
  });
};
