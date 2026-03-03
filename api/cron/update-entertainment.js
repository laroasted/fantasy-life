/**
* Fantasy Life — Actor/Actress Box Office + RT Score Updater
* 
* Uses TMDB for box office revenue and OMDB for Rotten Tomatoes scores.
* Score per film = (Worldwide BO in $M) × (RT% / 100)
* 
* - Searches TMDB for each actor's films released during Fantasy Year
* - Gets worldwide revenue from TMDB
* - Gets RT score from OMDB
* - Updates film_entries table and recalculates base points
* - Bonus points are NEVER touched
* 
* Deploy as: api/cron/update-entertainment.js
* Schedule: weekly on Mondays at 3 AM UTC (Sun 10 PM ET)
*/

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const OMDB_API_KEY = process.env.OMDB_API_KEY;

const TMDB_BASE = 'https://api.themoviedb.org/3';

// Fantasy Year window
const FY_START = '2025-03-15';
const FY_END = '2026-03-14';

// Delay helper to avoid rate limits
const delay = (ms) => new Promise(r => setTimeout(r, ms));

/**
* Search TMDB for a person by name, return their ID
*/
async function findPersonId(name) {
 try {
  const url = `${TMDB_BASE}/search/person?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(name)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  
  if (!data.results || data.results.length === 0) return null;
  
  // Find best match — prefer exact name match
  const exact = data.results.find(p => 
   p.name.toLowerCase() === name.toLowerCase()
  );
  return exact ? exact.id : data.results[0].id;
 } catch (err) {
  console.error(` TMDB search error for "${name}":`, err.message);
  return null;
 }
}

/**
* Get an actor's movie credits from TMDB, filtered to Fantasy Year
*/
async function getActorFilms(personId) {
 try {
  const url = `${TMDB_BASE}/person/${personId}/movie_credits?api_key=${TMDB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  
  const cast = data.cast || [];
  
  // Filter to films released during Fantasy Year
  return cast.filter(film => {
   if (!film.release_date) return false;
   return film.release_date >= FY_START && film.release_date <= FY_END;
  }).map(film => ({
   tmdbId: film.id,
   title: film.title,
   releaseDate: film.release_date,
  }));
 } catch (err) {
  console.error(` TMDB credits error for person ${personId}:`, err.message);
  return [];
 }
}

/**
* Get worldwide box office revenue from TMDB for a specific film
* Returns revenue in millions
*/
async function getBoxOffice(tmdbId) {
 try {
  const url = `${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return 0;
  const data = await res.json();
  
  // Revenue is in dollars, convert to millions
  const revenue = data.revenue || 0;
  return revenue / 1000000;
 } catch (err) {
  return 0;
 }
}

/**
* Get Rotten Tomatoes score from OMDB by movie title and year
* Returns RT percentage (0-100)
*/
async function getRTScore(title, year) {
 try {
  const url = `https://www.omdbapi.com/?apikey=${OMDB_API_KEY}&t=${encodeURIComponent(title)}&y=${year}&type=movie`;
  const res = await fetch(url);
  if (!res.ok) return 0;
  const data = await res.json();
  
  if (data.Response === 'False') return 0;
  
  // Find Rotten Tomatoes rating in the Ratings array
  const ratings = data.Ratings || [];
  const rt = ratings.find(r => r.Source === 'Rotten Tomatoes');
  
  if (rt && rt.Value) {
   // Value is like "85%"
   return parseInt(rt.Value.replace('%', '')) || 0;
  }
  
  return 0;
 } catch (err) {
  return 0;
 }
}

/**
* Format date from YYYY-MM-DD to MM-DD-YY
*/
function formatDate(isoDate) {
 if (!isoDate) return '';
 const parts = isoDate.split('-');
 if (parts.length !== 3) return isoDate;
 return `${parts[1]}-${parts[2]}-${parts[0].slice(2)}`;
}

module.exports = async function handler(req, res) {
 // Auth check
 const authHeader = req.headers['authorization'];
 const cronSecret = process.env.CRON_SECRET;
 if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
  return res.status(401).json({ error: 'Unauthorized' });
 }

 if (!SUPABASE_SERVICE_KEY) {
  return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY' });
 }
 if (!TMDB_API_KEY) {
  return res.status(500).json({ error: 'Missing TMDB_API_KEY' });
 }
 if (!OMDB_API_KEY) {
  return res.status(500).json({ error: 'Missing OMDB_API_KEY' });
 }

 const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

 console.log(' Fantasy Life — Updating Actor/Actress Box Office...\n');

 // Find active season
 const { data: season } = await supabase
  .from('seasons')
  .select('year')
  .eq('status', 'active')
  .single();

 if (!season) {
  return res.status(200).json({ message: 'No active season found' });
 }

 const seasonYear = season.year;
 const results = {};

 for (const category of ['Actor', 'Actress']) {
  console.log(`Processing ${category}...`);

  // 1. Get picks from Supabase
  const { data: picks, error: pickErr } = await supabase
   .from('picks')
   .select('id, member_id, pick, base, bonus')
   .eq('season_year', seasonYear)
   .eq('category', category);

  if (pickErr || !picks || picks.length === 0) {
   console.log(` ${category}: No picks found, skipping`);
   results[category] = { status: 'skipped', reason: 'no picks' };
   continue;
  }

  const rankings = [];

  // 2. For each pick, find films and update scores
  for (const pick of picks) {
   const actorName = pick.pick;
   console.log(` ${pick.member_id}: ${actorName}`);

   // Find person on TMDB
   const personId = await findPersonId(actorName);
   await delay(250); // rate limit courtesy

   if (!personId) {
    console.log(`  Could not find "${actorName}" on TMDB — preserving existing data`);
    // Get existing total from film_entries
    const { data: existingFilms } = await supabase
     .from('film_entries')
     .select('score')
     .eq('pick_id', pick.id);
    const existingTotal = (existingFilms || []).reduce((sum, f) => sum + Number(f.score || 0), 0);
    rankings.push({
     member: pick.member_id,
     pick: actorName,
     totalScore: existingTotal,
     films: [],
     status: 'not found on TMDB',
    });
    continue;
   }

   // Get their films in the Fantasy Year
   const films = await getActorFilms(personId);
   await delay(250);

   const filmResults = [];

   for (const film of films) {
    // Get box office
    const boMillions = await getBoxOffice(film.tmdbId);
    await delay(200);

    // Get RT score
    const releaseYear = film.releaseDate.split('-')[0];
    const rtScore = await getRTScore(film.title, releaseYear);
    await delay(200);

    // Calculate combined score
    const score = Math.round((boMillions * rtScore / 100) * 100) / 100;

    filmResults.push({
     title: film.title,
     releaseDate: formatDate(film.releaseDate),
     bo: Math.round(boMillions * 100) / 100,
     rt: rtScore,
     score,
    });

    console.log(`  ${film.title}: BO=$${boMillions.toFixed(1)}M, RT=${rtScore}%, Score=${score.toFixed(2)}`);
   }

   // Calculate total score
   const totalScore = filmResults.reduce((sum, f) => sum + f.score, 0);

   // 3. Update film_entries in Supabase
   // Delete existing entries and insert fresh ones
   if (filmResults.length > 0) {
    await supabase.from('film_entries').delete().eq('pick_id', pick.id);

    const filmRows = filmResults.map(f => ({
     pick_id: pick.id,
     title: f.title,
     release_date: f.releaseDate,
     box_office: f.bo,
     rotten_tom: f.rt,
     score: f.score,
    }));

    const { error: filmErr } = await supabase.from('film_entries').insert(filmRows);
    if (filmErr) {
     console.error(`  Failed to update films for ${actorName}:`, filmErr.message);
    }
   }

   // Update the pick's metric (totalScore) — but NOT base yet (we rank after all picks)
   await supabase.from('picks').update({
    metric: Math.round(totalScore * 100) / 100,
    updated_at: new Date().toISOString(),
   }).eq('id', pick.id);

   rankings.push({
    member: pick.member_id,
    pick: actorName,
    totalScore: Math.round(totalScore * 100) / 100,
    filmCount: filmResults.length,
    films: filmResults.map(f => `${f.title} ($${f.bo}M × ${f.rt}% = ${f.score})`),
   });
  }

  // 4. Rank by total score and assign base points
  rankings.sort((a, b) => b.totalScore - a.totalScore);
  const totalMembers = picks.length;

  let updated = 0;
  for (let i = 0; i < rankings.length; i++) {
   const r = rankings[i];
   const newBase = totalMembers - i;
   r.base = newBase;
   r.rank = i + 1;

   const matchingPick = picks.find(p => p.member_id === r.member);
   if (matchingPick) {
    const { error } = await supabase.from('picks').update({
     base: newBase,
    }).eq('id', matchingPick.id);

    if (!error) updated++;
   }
  }

  console.log(` ${category}: Updated ${updated}/${picks.length} picks\n`);
  results[category] = {
   status: 'updated',
   updated,
   total: picks.length,
   rankings: rankings.map(r => ({
    rank: r.rank,
    member: r.member,
    pick: r.pick,
    totalScore: r.totalScore,
    filmCount: r.filmCount,
    base: r.base,
    films: r.films,
   })),
  };
 }

 const summary = {
  message: 'Actor/Actress box office update complete',
  season: seasonYear,
  timestamp: new Date().toISOString(),
  results,
 };

 console.log(' Done!');
 return res.status(200).json(summary);
};