// Fantasy-year boundaries — league rules (confirmed by the commissioner, 2026-11):
//
// - The Oscars are always the LAST scored event of a fantasy year, so the
//   {year} season ends on the night of the {year + 1} Academy Awards
//   (2026 season → 99th Oscars, March 14 2027). That date moves every year,
//   so it's resolved live from the ceremony's own Wikipedia infobox instead
//   of trusting a hand-entered seasons.fy_end.
// - The active season only switches at the next draft. The draft can land
//   on Oscar day itself (it did in 2026), so a season's Oscars can air after
//   the switch — see update-entertainment.js's prior-season carry-over pass.
//
// Underscore-prefixed directory: not a Vercel Serverless Function, so this
// doesn't count against the Hobby plan's 12-function cap (see AGENTS.md).

// Same fetcher update-entertainment.js / update-billboard.js each carry
// their own copy of; exported here for crons that don't (update-sports.js).
async function fetchWikipediaWikitext(title) {
  try {
    var url = 'https://en.wikipedia.org/w/api.php?action=parse&page=' + encodeURIComponent(title) + '&prop=wikitext&format=json&redirects=1';
    var res = await fetch(url, { headers: { 'User-Agent': 'FantasyLifeHub/1.0 (private league scoring tool)' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    var data = await res.json();
    if (data.error) return null;
    return (data.parse && data.parse.wikitext && data.parse.wikitext['*']) || null;
  } catch (err) { console.error('  Wikipedia fetch failed for "' + title + '":', err.message); return null; }
}

// Handles both infobox shapes: "| date = March 14, 2027" and
// "| date = {{Start date|2027|03|14}}". Returns a UTC-midnight Date or null.
function parseInfoboxDate(wikitext) {
  if (!wikitext) return null;
  var m = wikitext.match(/\{\{Infobox[^\n]*/);
  if (!m) return null;
  var block = wikitext.slice(m.index, m.index + 3000);
  var tpl = block.match(/\|\s*date\s*=\s*\{\{\s*start date[^|}]*\|\s*(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/i);
  if (tpl) return new Date(Date.UTC(Number(tpl[1]), Number(tpl[2]) - 1, Number(tpl[3])));
  var plain = block.match(/\|\s*date\s*=\s*([^\n|{]+)/);
  if (!plain) return null;
  var parsed = new Date(plain[1].trim() + ' UTC');
  if (isNaN(parsed.getTime())) parsed = new Date(plain[1].trim());
  return isNaN(parsed.getTime()) ? null : parsed;
}

// 'YYYY-MM-DD' of the Oscar night that closes `seasonYear`, or null if the
// ceremony article / its date can't be resolved yet. `fetchWikitext` is the
// calling cron's own Wikipedia fetcher (title → wikitext | null).
async function resolveOscarNight(seasonYear, fetchWikitext) {
  var title = (Number(seasonYear) + 1) + ' Academy Awards';
  var date = parseInfoboxDate(await fetchWikitext(title));
  return date ? date.toISOString().slice(0, 10) : null;
}

// Effective end of the fantasy year: Oscar night when known, otherwise the
// seasons.fy_end fallback.
async function resolveFantasyYearEnd(seasonYear, fyEndFallback, fetchWikitext) {
  var oscarNight = await resolveOscarNight(seasonYear, fetchWikitext);
  if (oscarNight) {
    if (fyEndFallback && fyEndFallback !== oscarNight) {
      console.log('  Fantasy year end: using Oscar night ' + oscarNight + ' (seasons.fy_end says ' + fyEndFallback + ')');
    }
    return oscarNight;
  }
  console.log('  Fantasy year end: Oscar night not resolvable yet, falling back to seasons.fy_end ' + fyEndFallback);
  return fyEndFallback;
}

module.exports = { fetchWikipediaWikitext, parseInfoboxDate, resolveOscarNight, resolveFantasyYearEnd };
