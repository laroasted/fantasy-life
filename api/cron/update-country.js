/**
 * Fantasy Life — Country GDP + Olympics Updater
 *
 * GDP DATA SOURCE: IMF's official SDMX 2.1 API (api.imf.org), NGDP_RPCH —
 *   Real GDP growth, annual percent change — fetched live on every run:
 *   https://api.imf.org/external/sdmx/2.1/data/IMF.RES,WEO/.NGDP_RPCH.A
 *     ?startPeriod={year}&endPeriod={year}
 *   (the empty first key segment wildcards the COUNTRY dimension, so one
 *   request returns every economy for just the one indicator/year needed)
 *   - Free, no key, no auth. NOT the same host as the public DataMapper
 *     website (www.imf.org/external/datamapper) — that one sits behind
 *     bot-detection that 403s a plain server-side fetch regardless of
 *     headers (confirmed live on Vercel); api.imf.org is IMF's actual API
 *     product and has no such protection (also confirmed live on Vercel).
 *   - Response is SDMX-ML XML, not JSON (the server ignores an
 *     Accept: application/vnd.sdmx.data+json request and always returns
 *     XML) — parsed below with a regex over the flat
 *     <Series COUNTRY="X"><Obs TIME_PERIOD="Y" OBS_VALUE="Z"/></Series>
 *     shape, the same crude-but-adequate approach this file already uses
 *     for ESPN's HTML in fetchOlympicMedals, rather than a new XML
 *     dependency for one simple, stable shape.
 *   - IMF only republishes WEO forecasts twice a year (April/October), so
 *     this won't change more often than that — but it removes the old
 *     dependency on a commissioner remembering to hand-run SQL each time.
 *   - On fetch failure, falls back to the last successfully-fetched values
 *     cached in seasons.gdp_forecasts (same column, now a cache rather than
 *     the primary source):
 *     { "source": "IMF World Economic Outlook (published 2026-10-13)",
 *       "year": 2026, "data": { "GIN": 7.19, "USA": 2.33, ... },
 *       "fetched_at": "..." }
 *
 * OLYMPIC DATA: Still fetched live from ESPN during Olympic windows
 *
 * Respects commissioner locks from seasons.locks column.
 *
 * Tiebreaker: countries with the same GDP growth % split/average the base
 * points they collectively occupy.
 */
 
const { createClient } = require('@supabase/supabase-js');
const { writeScoreEventsAndNotify } = require('../_lib/push');
const { COUNTRY_ISO3 } = require('../../src/constants/countries');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// COUNTRY_ISO3 (country/alias name → ISO 3166-1 alpha-3 code, used to map a
// pick to the ISO keys in gdp_forecasts.data) now lives in
// src/constants/countries.js, shared with the draft tool's Country dropdown
// — see that file's comment for why. Importing the same list here means a
// name offered at draft time is, by construction, one this lookup can
// resolve; previously this file had its own separate copy that the draft
// tool's free-text Country field had no way to stay in sync with.
 
// ═══════════════════════════════════════════════════════════════════════
// COMPREHENSIVE NOC (Olympic committee) CODE LOOKUP
// ═══════════════════════════════════════════════════════════════════════
const COUNTRY_NOC = {
  'Norway': 'NOR', 'South Sudan': 'SSD', 'Germany': 'GER',
  'United States': 'USA', 'Russia': 'ROC', 'India': 'IND',
  'Libya': 'LBA', 'Ethiopia': 'ETH', 'Guyana': 'GUY',
  'Canada': 'CAN', 'Philippines': 'PHI',
  'Sudan': 'SUD', 'Finland': 'FIN', 'Vietnam': 'VIE',
  'Ireland': 'IRL', 'Guinea': 'GUI',
  'Argentina': 'ARG', 'Australia': 'AUS', 'Austria': 'AUT',
  'Belgium': 'BEL', 'Brazil': 'BRA', 'Bulgaria': 'BUL',
  'Chile': 'CHI', 'China': 'CHN', 'Colombia': 'COL',
  'Croatia': 'CRO', 'Cuba': 'CUB', 'Czech Republic': 'CZE',
  'Czechia': 'CZE', 'Denmark': 'DEN', 'Ecuador': 'ECU',
  'Egypt': 'EGY', 'France': 'FRA', 'Great Britain': 'GBR',
  'United Kingdom': 'GBR', 'Greece': 'GRE', 'Hungary': 'HUN',
  'Indonesia': 'INA', 'Iran': 'IRI', 'Israel': 'ISR',
  'Italy': 'ITA', 'Jamaica': 'JAM', 'Japan': 'JPN',
  'Kazakhstan': 'KAZ', 'Kenya': 'KEN', 'South Korea': 'KOR',
  'Korea': 'KOR', 'Latvia': 'LAT', 'Lithuania': 'LTU',
  'Malaysia': 'MAS', 'Mexico': 'MEX', 'Mongolia': 'MGL',
  'Morocco': 'MAR', 'Netherlands': 'NED', 'New Zealand': 'NZL',
  'Nigeria': 'NGR', 'North Korea': 'PRK', 'Pakistan': 'PAK',
  'Peru': 'PER', 'Poland': 'POL', 'Portugal': 'POR',
  'Romania': 'ROU', 'Saudi Arabia': 'KSA', 'Serbia': 'SRB',
  'Singapore': 'SGP', 'Slovakia': 'SVK', 'Slovenia': 'SLO',
  'South Africa': 'RSA', 'Spain': 'ESP', 'Sweden': 'SWE',
  'Switzerland': 'SUI', 'Thailand': 'THA', 'Turkey': 'TUR',
  'Ukraine': 'UKR', 'Uruguay': 'URU', 'Venezuela': 'VEN',
  'Zimbabwe': 'ZIM',
  // Added alongside the Country dropdown (src/constants/countries.js) going
  // live with all ~196 ISO-recognized countries as real options instead of
  // free text only — these four are real Winter Olympics medal nations that
  // were reachable before only by typing the name exactly, and were missing
  // here same as the other ~118 non-winter-sport nations in that list that
  // have no NOC entry because there's genuinely no medal data to match
  // regardless of whether a code exists for them. These four are different:
  // real historical Winter medalists, so the gap was an actual scoring
  // miss, not a no-op. Codes confirmed against the current IOC country-code
  // list (en.wikipedia.org/wiki/List_of_IOC_country_codes).
  'Belarus': 'BLR', 'Estonia': 'EST',
  'Liechtenstein': 'LIE', 'Uzbekistan': 'UZB',
};
 
const OLYMPIC_BONUS = { 1: 10, 2: 7, 3: 5, 4: 3, 5: 2 };
 
// ═══════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════
 
function assignBasePointsWithTiebreaker(gdpResults, totalMembers) {
  var n = gdpResults.length;
  var i = 0;
  while (i < n) {
    if (gdpResults[i].gdpGrowth === null) { i++; continue; }
    var j = i;
    while (j < n && gdpResults[j].gdpGrowth !== null && gdpResults[j].gdpGrowth === gdpResults[i].gdpGrowth) j++;
    var pointSum = 0;
    for (var p = i; p < j; p++) pointSum += (totalMembers - p);
    var avgPoints = Math.round((pointSum / (j - i)) * 100) / 100;
    for (var p = i; p < j; p++) {
      gdpResults[p].newBase = avgPoints;
      gdpResults[p].rank = i + 1;
    }
    i = j;
  }
  return gdpResults;
}
 
function isFieldLocked(locks, category, ownerName, field) {
  return locks ? !!locks[category + '|' + ownerName + '|' + field] : false;
}
 
function getCountryISO(pickName) {
  if (!pickName) return null;
  if (COUNTRY_ISO3[pickName]) return COUNTRY_ISO3[pickName];
  var lower = pickName.toLowerCase().trim();
  for (var [name, code] of Object.entries(COUNTRY_ISO3)) {
    if (name.toLowerCase() === lower) return code;
  }
  console.warn('  ⚠ No ISO code for: "' + pickName + '" — add it to COUNTRY_ISO3!');
  return null;
}
 
function getCountryNOC(pickName) {
  if (!pickName) return null;
  if (COUNTRY_NOC[pickName]) return COUNTRY_NOC[pickName];
  var lower = pickName.toLowerCase().trim();
  for (var [name, code] of Object.entries(COUNTRY_NOC)) {
    if (name.toLowerCase() === lower) return code;
  }
  return null;
}
 
function matchOlympicMedals(pickName, medalData) {
  var noc = getCountryNOC(pickName);
  return noc ? (medalData.find(function(m) { return m.noc === noc; }) || null) : null;
}
 
async function fetchIMFGdpData(year) {
  try {
    // Empty COUNTRY segment (before the first dot) wildcards every economy —
    // one request returns all of them for just this indicator/year.
    var url = 'https://api.imf.org/external/sdmx/2.1/data/IMF.RES,WEO/.NGDP_RPCH.A' +
      '?startPeriod=' + year + '&endPeriod=' + year;
    var res = await fetch(url);
    if (!res.ok) {
      console.error('  IMF SDMX fetch failed: HTTP ' + res.status);
      return null;
    }
    var xml = await res.text();

    // Structure-specific SDMX-ML: <Series COUNTRY="X" ...><Obs TIME_PERIOD="Y"
    // OBS_VALUE="Z"/></Series> — flat attributes, no nested value elements.
    var data = {};
    var seriesRe = /<Series\s+COUNTRY="([A-Z]{3})"[^>]*>([\s\S]*?)<\/Series>/g;
    var obsRe = /<Obs\s+TIME_PERIOD="(\d{4})"\s+OBS_VALUE="(-?[\d.]+)"/;
    var sm;
    while ((sm = seriesRe.exec(xml)) !== null) {
      var om = obsRe.exec(sm[2]);
      if (om && om[1] === String(year)) data[sm[1]] = parseFloat(om[2]);
    }
    if (Object.keys(data).length === 0) {
      console.error('  IMF SDMX response had no parseable ' + year + ' observations');
      return null;
    }

    var pubMatch = /PUBLICATION_DATE="([^"]+)"/.exec(xml);
    var source = 'IMF World Economic Outlook' +
      (pubMatch ? ' (published ' + pubMatch[1].slice(0, 10) + ')' : '');

    return { source: source, year: year, data: data };
  } catch (err) {
    console.error('  IMF SDMX fetch error:', err.message);
    return null;
  }
}

async function fetchOlympicMedals() {
  try {
    var res = await fetch('https://www.espn.com/olympics/winter/2026/medals', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return null;
    var html = await res.text();
    var medals = [];
    var pattern = /([A-Z]{3})[^0-9]*(\d+)[^0-9]+(\d+)[^0-9]+(\d+)[^0-9]+(\d+)/g;
    var match;
    while ((match = pattern.exec(html)) !== null) {
      var noc = match[1];
      if (['THE', 'FOR', 'AND', 'ALL', 'TOP'].includes(noc)) continue;
      medals.push({
        noc: noc,
        gold: parseInt(match[2]),
        silver: parseInt(match[3]),
        bronze: parseInt(match[4]),
        total: parseInt(match[5])
      });
    }
    if (medals.length > 0) {
      medals.sort(function(a, b) { return b.total - a.total || b.gold - a.gold; });
    }
    return medals.length > 0 ? medals : null;
  } catch (err) {
    console.error('  Olympics fetch error:', err.message);
    return null;
  }
}
 
// ═══════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════

module.exports = async function handler(req, res) {
  var authHeader = req.headers['authorization'];
  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });
  }
 
  var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log('═══ Fantasy Life — Country GDP + Olympics Update ═══');

  // ── Load active season (including cached gdp_forecasts as fallback) ──
  var { data: season } = await supabase
    .from('seasons')
    .select('year, locks, gdp_forecasts')
    .eq('status', 'active')
    .single();
  if (!season) return res.status(200).json({ message: 'No active season found' });

  var fantasyYear = season.year;
  var locks = season.locks || {};
  console.log('Season: ' + fantasyYear);

  // ── GDP data: fetch live from IMF, fall back to last cached pull ──
  console.log('\n── Fetching live IMF WEO GDP growth data ──');
  var liveGdp = await fetchIMFGdpData(fantasyYear);
  var cachedGdp = season.gdp_forecasts;

  var gdpData, gdpSource, gdpYear, gdpIsLive;

  if (liveGdp) {
    console.log('Live IMF fetch OK — ' + Object.keys(liveGdp.data).length +
      ' countries, source: ' + liveGdp.source);
    gdpData = liveGdp.data;
    gdpSource = liveGdp.source;
    gdpYear = liveGdp.year;
    gdpIsLive = true;

    var { error: cacheErr } = await supabase
      .from('seasons')
      .update({
        gdp_forecasts: {
          source: gdpSource,
          year: gdpYear,
          data: gdpData,
          fetched_at: new Date().toISOString()
        }
      })
      .eq('year', fantasyYear);
    if (cacheErr) {
      console.error('  Failed to cache fresh IMF data to gdp_forecasts:', cacheErr.message);
    }
  } else if (cachedGdp && cachedGdp.data) {
    console.log('Live IMF fetch unavailable — falling back to cached gdp_forecasts');
    gdpData = cachedGdp.data;
    gdpSource = (cachedGdp.source || 'unknown') + ' (cached — live fetch failed this run)';
    gdpYear = cachedGdp.year || fantasyYear;
    gdpIsLive = false;
  } else {
    return res.status(200).json({
      message: 'IMF live fetch failed and no cached gdp_forecasts found on season ' + fantasyYear
    });
  }

  console.log('GDP data source: ' + gdpSource);
  console.log('GDP data year: ' + gdpYear);
  console.log('GDP entries: ' + Object.keys(gdpData).length + ' countries');
 
  // ── Load members ──
  var { data: membersArr } = await supabase.from('members').select('id, name');
  var memberNameById = {};
  (membersArr || []).forEach(function(m) { memberNameById[m.id] = m.name; });
 
  // ── Load Country picks ──
  var { data: picks } = await supabase
    .from('picks')
    .select('id, member_id, pick, base, bonus, metric')
    .eq('season_year', fantasyYear)
    .eq('category', 'Country');
  if (!picks || picks.length === 0) {
    return res.status(200).json({ message: 'No Country picks found' });
  }
 
  var totalMembers = picks.length;
  console.log('Found ' + totalMembers + ' Country picks\n');
 
  var results = { gdp: null, olympics: null };
  // Shared across both the GDP and Olympics sections below — Country is
  // the only category where two independent mechanisms can each produce
  // a nonzero change for the same member in the same run; both feed one
  // writeScoreEventsAndNotify() call at the end so that member still gets
  // exactly one push (see buildScoreDigest()'s own comment in push.js for
  // how the digest text stays accurate when that happens).
  var scoreEvents = [];
 
  // ════════════════════════════════════════════════════════════════════
  // GDP UPDATE (from Supabase)
  // ════════════════════════════════════════════════════════════════════
  console.log('── GDP Update ──');
 
  var gdpResults = picks.map(function(p) {
    var iso = getCountryISO(p.pick);
    var growth = (iso && gdpData[iso] != null) ? gdpData[iso] : null;
    if (growth !== null) growth = Math.round(parseFloat(growth) * 10) / 10;
    var ownerName = memberNameById[p.member_id] || p.member_id;
    console.log('  ' + ownerName + ': ' + p.pick + ' (' + (iso || '?') + ') → ' +
      (growth !== null ? growth + '%' : 'NO DATA — add ' + iso + ' to gdp_forecasts'));
    return { ...p, gdpGrowth: growth, iso: iso };
  });
 
  var withData = gdpResults.filter(function(r) { return r.gdpGrowth !== null; });
 
  if (withData.length > 0) {
    // Sort descending by gdpGrowth (nulls last)
    gdpResults.sort(function(a, b) {
      if (a.gdpGrowth === null && b.gdpGrowth === null) return 0;
      if (a.gdpGrowth === null) return 1;
      if (b.gdpGrowth === null) return -1;
      return b.gdpGrowth - a.gdpGrowth;
    });
 
    gdpResults = assignBasePointsWithTiebreaker(gdpResults, totalMembers);
 
    console.log('\nRankings:');
    gdpResults.forEach(function(r) {
      if (r.gdpGrowth !== null) {
        console.log('  #' + r.rank + ' ' + r.pick + ': ' + r.gdpGrowth + '% → ' + r.newBase + ' base pts');
      } else {
        console.log('  — ' + r.pick + ': No data (skipped)');
      }
    });
 
    var updated = 0;
    var rankings = [];
 
    for (var r of gdpResults) {
      var ownerName = memberNameById[r.member_id] || r.member_id;
      var skipped = [];
      var baseWritten = null;
      var metricWritten = null;

      if (r.gdpGrowth !== null) {
        // Settings' Country panel has one lock button on the single "GDP %"
        // input (SeasonSettings.jsx's `gdpKey` = "Country|<owner>|gdp") —
        // not separate base/metric locks like other categories get. Both
        // base and metric are derived from that one number, so one lock
        // key guards both writes.
        var gdpLocked = isFieldLocked(locks, 'Country', ownerName, 'gdp');
        var baseLocked = gdpLocked;
        var metricLocked = gdpLocked;

        var recordLabel = r.gdpGrowth + '% GDP';

        var updateObj = { updated_at: new Date().toISOString() };
        if (!baseLocked) {
          updateObj.base = r.newBase;
          baseWritten = r.newBase;
        }
        if (!metricLocked) {
          updateObj.metric = r.gdpGrowth;
          updateObj.record = recordLabel;
          metricWritten = r.gdpGrowth;
        }

        if (baseLocked) skipped.push('base');
        if (metricLocked) skipped.push('metric');
        if (skipped.length > 0) {
          console.log('  🔒 ' + ownerName + ': skipped locked: ' + skipped.join(', '));
        }

        // Optimistic concurrency on `base` (the only field GDP's own
        // delta below is computed from) — same fix, same reasoning as
        // update-sports.js's identical comment: without conditioning on
        // the pre-update value just read (r.base), two near-simultaneous
        // invocations of this cron (the scheduled monthly run and a
        // visitor's manual Refresh via api/refresh-all.js, or a retried
        // Vercel cron trigger) both push their own score_events row for
        // the same real change. Whichever commits first moves base away
        // from what this one read, so a second invocation's conditional
        // UPDATE matches zero rows.
        var updateQuery = supabase.from('picks').update(updateObj).eq('id', r.id);
        if (!baseLocked) updateQuery = updateQuery.eq('base', r.base);
        var { data: updatedRows, error } = await updateQuery.select('id');
        if (error) {
          console.error('  DB error updating ' + r.pick + ':', error.message);
        } else if (!updatedRows || updatedRows.length === 0) {
          console.log('  ' + ownerName + ': base changed under us (a concurrent run already applied this) — skipping duplicate score event');
        } else {
          updated++;

          var newBaseVal = baseLocked ? (Number(r.base) || 0) : (Number(r.newBase) || 0);
          var gdpDelta = Math.round((newBaseVal - (Number(r.base) || 0)) * 10) / 10;
          if (gdpDelta !== 0) {
            scoreEvents.push({
              season_year: fantasyYear,
              member_id: r.member_id,
              category: 'Country',
              delta: gdpDelta,
              cause: r.pick + ' (' + recordLabel + (r.rank ? ', #' + r.rank : '') + ')',
              source: 'update-country-gdp',
            });
          }
        }
      }

      // Diagnostic fields so a QA pass can tell "nothing changed because the
      // number is genuinely the same" apart from "nothing changed because a
      // lock blocked the write" without needing to read Vercel's own logs.
      rankings.push({
        rank: r.rank || null,
        member: r.member_id,
        owner: ownerName,
        country: r.pick,
        iso: r.iso,
        gdpGrowth: r.gdpGrowth !== null ? r.gdpGrowth + '%' : 'No data',
        base: r.newBase || null,
        previousBase: r.base != null ? r.base : null,
        previousMetric: r.metric != null ? r.metric : null,
        locked: skipped.length > 0 ? skipped : null,
        baseActuallyChanged: baseWritten !== null && baseWritten !== r.base,
        metricActuallyChanged: metricWritten !== null && metricWritten !== r.metric
      });
    }
 
    console.log('\nGDP: Updated ' + updated + '/' + totalMembers + ' countries');
    results.gdp = {
      status: 'updated',
      source: gdpSource,
      dataIsLive: gdpIsLive,
      dataYear: gdpYear,
      updated: updated,
      total: totalMembers,
      rankings: rankings
    };
  } else {
    console.log('No GDP data matched any picks — check gdp_forecasts ISO codes');
    results.gdp = { status: 'skipped', reason: 'no matching GDP data' };
  }
 
  // ════════════════════════════════════════════════════════════════════
  // OLYMPICS UPDATE
  // ════════════════════════════════════════════════════════════════════
  var now = new Date();
  var calYear = now.getFullYear();
  var month = now.getMonth() + 1;
  var isWinterOlympicYear = (calYear - 2026) % 4 === 0;
  var isSummerOlympicYear = (calYear - 2028) % 4 === 0;
  var isOlympicWindow = (isWinterOlympicYear && (month === 2 || month === 3)) ||
    (isSummerOlympicYear && (month === 7 || month === 8));
 
  if (isOlympicWindow) {
    console.log('\n── Olympics Update ──');
    var medalData = await fetchOlympicMedals();
 
    if (medalData) {
      console.log('Found medal data for ' + medalData.length + ' countries');
      var olympicsUpdated = 0;
      var medalRankings = [];
 
      for (var pick of picks) {
        var ownerName2 = memberNameById[pick.member_id] || pick.member_id;
        var medals = matchOlympicMedals(pick.pick, medalData);
 
        if (medals) {
          var noc = getCountryNOC(pick.pick);
          var rankIdx = medalData.findIndex(function(m) { return m.noc === noc; });
          var medalRank = rankIdx >= 0 ? rankIdx + 1 : null;
          var bonusPts = OLYMPIC_BONUS[medalRank] || 0;
          // Same pattern as the GDP lock above: Settings locks individual
          // olympics.{gold,silver,bronze,rank} fields, not a "bonus" key.
          // bonusPts is derived from rank specifically, so that's the lock
          // that should guard it.
          var bonusLocked = isFieldLocked(locks, 'Country', ownerName2, 'olympics.rank');
          var medalNote = medalRank && medalRank <= 5
            ? '#' + medalRank + ' by total medals (' + medals.total + ')'
            : medals.total > 0
              ? medals.total + ' medals, outside top 5'
              : 'No medals';

          var { error: olyErr } = await supabase
            .from('country_olympics')
            .upsert({
              pick_id: pick.id,
              medal_rank: medalRank,
              gold: medals.gold,
              silver: medals.silver,
              bronze: medals.bronze,
              total_medals: medals.total,
              pts: bonusPts,
              note: medalNote
            }, { onConflict: 'pick_id' });

          var picksWriteOk = true;
          if (!olyErr && !bonusLocked) {
            // Optimistic concurrency on `bonus` (the only field this
            // Olympics delta is computed from) — same fix, same
            // reasoning as the GDP block above and update-sports.js's
            // original comment: without conditioning on the pre-update
            // value just read (pick.bonus), two near-simultaneous
            // invocations of this cron both push their own score_events
            // row for the same real medal-count change. A lost race sets
            // picksWriteOk = false, the same flag an outright write error
            // already uses to suppress the duplicate score event below.
            var { data: updatedPicksRows, error: picksErr } = await supabase.from('picks').update({
              bonus: bonusPts,
              bonus_note: bonusPts > 0 ? medalNote : '',
              updated_at: new Date().toISOString()
            }).eq('id', pick.id).eq('bonus', pick.bonus).select('id');
            if (picksErr) {
              console.error('  DB error updating bonus for ' + pick.pick + ':', picksErr.message);
              picksWriteOk = false;
            } else if (!updatedPicksRows || updatedPicksRows.length === 0) {
              console.log('  ' + ownerName2 + ': bonus changed under us (a concurrent run already applied this) — skipping duplicate score event');
              picksWriteOk = false;
            } else {
              olympicsUpdated++;
            }
          } else if (bonusLocked) {
            console.log('  🔒 ' + ownerName2 + ': bonus locked');
            olympicsUpdated++;
          }

          // Diff against the pre-fetched `picks` bonus — skipped if either
          // write failed (the country_olympics upsert or the picks bonus
          // update itself), same as every other cron's "don't diff a write
          // that didn't happen" rule. A locked bonus leaves picksWriteOk at
          // its default `true` with newBonusVal equal to the old value, so
          // the diff below naturally computes to 0 — no special-casing needed.
          if (!olyErr && picksWriteOk) {
            var newBonusVal = bonusLocked ? (Number(pick.bonus) || 0) : (Number(bonusPts) || 0);
            var olympicsDelta = Math.round((newBonusVal - (Number(pick.bonus) || 0)) * 10) / 10;
            if (olympicsDelta !== 0) {
              scoreEvents.push({
                season_year: fantasyYear,
                member_id: pick.member_id,
                category: 'Country',
                delta: olympicsDelta,
                cause: pick.pick + ' (' + medalNote + ')',
                source: 'update-country-olympics',
              });
            }
          }
 
          medalRankings.push({
            member: pick.member_id, owner: ownerName2, country: pick.pick,
            gold: medals.gold, silver: medals.silver, bronze: medals.bronze,
            total: medals.total, medalRank: medalRank, bonusPts: bonusPts
          });
        } else {
          medalRankings.push({
            member: pick.member_id, owner: ownerName2, country: pick.pick,
            gold: 0, silver: 0, bronze: 0, total: 0,
            medalRank: null, bonusPts: 0
          });
        }
      }
 
      console.log('Olympics: Updated ' + olympicsUpdated + '/' + totalMembers);
      results.olympics = { status: 'updated', updated: olympicsUpdated, rankings: medalRankings };
    } else {
      results.olympics = { status: 'skipped', reason: 'no medal data found' };
    }
  } else {
    console.log('\n── Olympics: Not in window (month=' + month + ', year=' + calYear + ') ──');
    results.olympics = { status: 'skipped', reason: 'not Olympic season' };
  }
 
  await writeScoreEventsAndNotify(supabase, scoreEvents, memberNameById);

  console.log('\n═══ Done! ═══');
  return res.status(200).json({
    message: 'Country update complete',
    season: fantasyYear,
    gdpSource: gdpSource,
    gdpIsLive: gdpIsLive,
    timestamp: new Date().toISOString(),
    results: results
  });
};
