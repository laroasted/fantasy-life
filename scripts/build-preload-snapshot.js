#!/usr/bin/env node
// Fantasy Life Hub — build-time season snapshot
//
// Why this exists: the app is a pure client-rendered SPA (src/index.js does
// a plain ReactDOM.createRoot(...).render(...), no server rendering). Every
// visit — including a crawler's, including AdSense's own review crawler —
// starts from an empty <div id="root"> and has to wait on a live Supabase
// fetch (src/App.jsx's loadSeason()) before any real content exists. A
// returning human on the same device skips that wait via the localStorage
// cache in readCachedActiveSeason() (src/utils/storage.js), but a first-ever
// visit — every crawler's visit, by definition — has nothing to seed from
// and sits on the "Loading scores..." spinner for however long that fetch
// takes. Confirmed directly: fetching this app's own Draft tab with a short
// crawl timeout returns literally nothing but that spinner text; the same
// URL with a few extra seconds of wait returns the real page.
//
// This script runs once per deploy (wired into `npm run build` below), does
// the same public, anon-key read `fetchSeasonFromSupabase()` does for the
// active season, and writes a minimal real snapshot to
// public/preload-season.js as a plain global (window.__PRELOADED_SEASON__).
// src/utils/storage.js's readPreloadedSeason() reads it back; App.jsx falls
// back to it (after the localStorage cache, before the old hardcoded
// build2025() stub) so EVERY visitor's very first paint has real member
// names and real scores already on screen — no network wait, no spinner —
// while the live fetch still runs immediately after and overwrites it with
// current data. This is intentionally a snapshot, not a replacement for the
// live fetch: it can be as stale as the last deploy.
//
// Deliberately minimal: only `categories` (the flat per-pick summary the
// main ranked Scoreboard view reads) is built, not the much larger
// `detailedData` (per-category round-by-round / film / chart breakdown
// fetchSeasonFromSupabase also builds) or `projections`. Scoreboard.jsx
// already treats both as optional elsewhere in the app's normal load
// sequence (`seasonData.detailedData || {}`, `seasonData.projections ||
// {}` — projections in particular is always empty on every normal page
// load until its own separate fetch resolves moments later), so a snapshot
// with real categories but empty detailedData/projections renders the real
// ranked list correctly; expanding a member's row just has nothing to show
// until the live fetch lands a moment later, same as projections already
// behave today.
//
// Safety: this must never be able to fail `npm run build` / a Vercel
// deploy. Every failure path below just logs and leaves the committed
// public/preload-season.js placeholder (window.__PRELOADED_SEASON__ = null)
// in place, which readPreloadedSeason() already treats as "nothing to
// preload" — the app falls back to exactly its pre-existing behavior.

const fs = require('fs');
const path = require('path');

// Kept in sync with src/utils/storage.js's own SUPABASE_URL/SUPABASE_ANON_KEY
// by hand — duplicated rather than imported because that file is an ES
// module written for the browser bundle (webpack/babel-transpiled `import`/
// `export`), not loadable as-is from a plain CommonJS Node build script.
// Both are the public anon/publishable key, safe to duplicate here — same
// key already ships in the browser bundle for every visitor.
const SUPABASE_URL = 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_9lGdGZ1EEifhWZlPRQa-WA_QVbPD6O6';

const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'preload-season.js');

function writePlaceholder(reason) {
  console.warn(`[build-preload-snapshot] Skipping (${reason}) — leaving existing public/preload-season.js as-is.`);
}

async function main() {
  let createClient;
  try {
    ({ createClient } = require('@supabase/supabase-js'));
  } catch (e) {
    writePlaceholder('@supabase/supabase-js not resolvable');
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  try {
    const [{ data: season, error: sErr }, { data: members, error: mErr }] = await Promise.all([
      supabase.from('seasons').select('*').eq('status', 'active').single(),
      supabase.from('members').select('*').order('id'),
    ]);

    if (sErr || !season) {
      writePlaceholder(`no active season (${sErr?.message || 'not found'})`);
      return;
    }
    if (mErr) {
      writePlaceholder(`members fetch failed (${mErr.message})`);
      return;
    }

    const { data: picks, error: pErr } = await supabase
      .from('picks')
      .select('*')
      .eq('season_year', season.year);

    if (pErr || !picks) {
      writePlaceholder(`picks fetch failed (${pErr?.message || 'no data'})`);
      return;
    }

    const memberNameById = {};
    members.forEach((m) => { memberNameById[m.id] = m.name; });

    const categories = {};
    picks.forEach((p) => {
      if (!categories[p.category]) categories[p.category] = [];
      categories[p.category].push({
        owner: memberNameById[p.member_id] || p.member_id,
        pick: p.pick,
        base: Number(p.base) || 0,
        bonus: Number(p.bonus) || 0,
        total: Number(p.total) || 0,
      });
    });

    const seasonMemberIds = new Set(picks.map((p) => p.member_id));
    const seasonMembers = members.filter((m) => seasonMemberIds.has(m.id));

    const snapshot = {
      year: season.year,
      name: season.name,
      draftDate: season.draft_date,
      memberCount: seasonMembers.length,
      members: seasonMembers.map((m) => ({ id: m.id, name: m.name, full: m.full_name })),
      categories,
      detailedData: {},
      locks: season.locks || {},
      paywalls: season.paywalls || {},
      status: season.status,
    };

    const generatedAt = new Date().toISOString();
    const fileContents =
      '// Auto-generated at build time by scripts/build-preload-snapshot.js — do not hand-edit.\n' +
      '// See that file for what this is and why it exists.\n' +
      `window.__PRELOADED_SEASON__ = ${JSON.stringify(snapshot)};\n` +
      `window.__PRELOADED_SEASON_GENERATED_AT__ = ${JSON.stringify(generatedAt)};\n`;

    fs.writeFileSync(OUTPUT_PATH, fileContents, 'utf8');
    console.log(
      `[build-preload-snapshot] Wrote real snapshot for season ${season.year} ` +
      `(${seasonMembers.length} members, ${picks.length} picks) at ${generatedAt}.`
    );
  } catch (e) {
    writePlaceholder(`unexpected error (${e && e.message})`);
  }
}

main();
