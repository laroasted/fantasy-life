/**
* Fantasy Life — Country GDP + Olympics Updater
* 
* GDP: Fetches latest GDP growth % from World Bank API.
*   Data lags ~6-12 months, so this pulls the most recent available year.
*   Runs monthly — no point checking more often.
* 
* Olympics: During Olympic weeks, scrapes medal counts from olympics.com.
*     Outside Olympic windows, skips.
*     Bonus points: 10/7/5/3/2 for top 5 by total medal count.
* 
* Deploy as: api/cron/update-country.js
* Schedule: 1st of each month at 7 AM UTC
*/

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Country name → ISO 3166-1 alpha-3 code (for World Bank API)
const COUNTRY_CODES = {
 'Norway': 'NOR', 'South Sudan': 'SSD', 'Germany': 'DEU',
 'United States': 'USA', 'Russia': 'RUS', 'India': 'IND',
 'Libya': 'LBY', 'Ethiopia': 'ETH', 'Guyana': 'GUY',
 'Canada': 'CAN', 'Philippines': 'PHL',
 // Common alternative names
 'US': 'USA', 'USA': 'USA', 'U.S.': 'USA',
};

// Country name → Olympics NOC code (for medal matching)
const COUNTRY_NOC = {
 'Norway': 'NOR', 'South Sudan': 'SSD', 'Germany': 'GER',
 'United States': 'USA', 'Russia': 'RUS', 'India': 'IND',
 'Libya': 'LBY', 'Ethiopia': 'ETH', 'Guyana': 'GUY',
 'Canada': 'CAN', 'Philippines': 'PHI',
};

// Olympics bonus points by total medal rank
const OLYMPIC_BONUS = { 1: 10, 2: 7, 3: 5, 4: 3, 5: 2 };

/**
* Fetch GDP growth rates from World Bank API.
* Returns the most recent year with data for each country.
*/
async function fetchGDPData(countryCodes) {
 try {
  const isoList = countryCodes.join(';');
  // Fetch last 3 years to find most recent available data
  const currentYear = new Date().getFullYear();
  const dateRange = `${currentYear - 3}:${currentYear}`;

  const url = `https://api.worldbank.org/v2/country/${isoList}/indicator/NY.GDP.MKTP.KD.ZG?format=json&date=${dateRange}&per_page=200`;
  const res = await fetch(url, {
   headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  if (!res.ok) {
   console.log(` World Bank API returned ${res.status}`);
   return null;
  }

  const data = await res.json();
  // World Bank returns [metadata, dataArray]
  const records = data[1];
  if (!records || records.length === 0) {
   console.log(' No GDP data returned from World Bank');
   return null;
  }

  // For each country, find the most recent year with non-null data
  const gdpByCountry = {};
  for (const record of records) {
   if (record.value === null) continue;
   const iso3 = record.countryiso3code || record.country?.id;
   const year = parseInt(record.date);
   const value = parseFloat(record.value);

   if (!gdpByCountry[iso3] || year > gdpByCountry[iso3].year) {
    gdpByCountry[iso3] = {
     countryName: record.country?.value || iso3,
     year,
     gdpGrowth: Math.round(value * 10) / 10, // Round to 1 decimal
    };
   }
  }

  console.log(` GDP data found for ${Object.keys(gdpByCountry).length} countries`);
  return gdpByCountry;
 } catch (err) {
  console.error(' GDP fetch error:', err.message);
  return null;
 }
}

/**
* Fetch Olympic medal counts by scraping olympics.com medal page.
* Returns array of { country, noc, gold, silver, bronze, total }
*/
async function fetchOlympicMedals() {
 try {
  // Try the 2026 Winter Olympics page
  const res = await fetch('https://www.espn.com/olympics/winter/2026/medals', {
   headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  if (!res.ok) {
   console.log(` ESPN Olympics returned ${res.status}`);
   return null;
  }

  const html = await res.text();
  const medals = [];

  // Parse medal table from ESPN HTML
  // ESPN shows: Country | Gold | Silver | Bronze | Total
  // Look for country rows with medal counts
  const rows = html.split(/<tr[^>]*>/);

  for (const row of rows) {
   // Try to extract country code and medal counts
   const countryMatch = row.match(/([A-Z]{3})\s*<\/(?:td|a|span)/);
   const numbers = row.match(/>(\d+)<\//g);

   if (countryMatch && numbers && numbers.length >= 3) {
    const noc = countryMatch[1];
    const nums = numbers.map(n => parseInt(n.replace(/[>/<]/g, '')));

    // Find gold, silver, bronze (usually the first 3-4 numbers)
    if (nums.length >= 4) {
     medals.push({
      noc,
      gold: nums[0],
      silver: nums[1],
      bronze: nums[2],
      total: nums[3],
     });
    }
   }
  }

  // Fallback: try simpler pattern matching
  if (medals.length === 0) {
   // Try regex for NOC codes followed by numbers
   const pattern = /([A-Z]{3})[^0-9]*(\d+)[^0-9]+(\d+)[^0-9]+(\d+)[^0-9]+(\d+)/g;
   let match;
   while ((match = pattern.exec(html)) !== null) {
    const noc = match[1];
    // Skip non-country codes
    if (['THE', 'FOR', 'AND', 'ALL', 'TOP'].includes(noc)) continue;
    medals.push({
     noc,
     gold: parseInt(match[2]),
     silver: parseInt(match[3]),
     bronze: parseInt(match[4]),
     total: parseInt(match[5]),
    });
   }
  }

  if (medals.length > 0) {
   console.log(` Found medal data for ${medals.length} countries`);
   // Sort by total medals descending
   medals.sort((a, b) => b.total - a.total || b.gold - a.gold);
  }

  return medals.length > 0 ? medals : null;
 } catch (err) {
  console.error(' Olympics fetch error:', err.message);
  return null;
 }
}

/**
* Match a picked country name to a World Bank ISO code
*/
function getCountryISO(pickName) {
 // Direct lookup
 if (COUNTRY_CODES[pickName]) return COUNTRY_CODES[pickName];
 // Case-insensitive search
 const lower = pickName.toLowerCase();
 for (const [name, code] of Object.entries(COUNTRY_CODES)) {
  if (name.toLowerCase() === lower) return code;
 }
 return null;
}

/**
* Match a picked country to Olympic medal data
*/
function matchOlympicMedals(pickName, medalData) {
 const noc = COUNTRY_NOC[pickName];
 if (!noc) return null;

 return medalData.find(m => m.noc === noc) || null;
}

module.exports = async function handler(req, res) {
 // Auth check
 const authHeader = req.headers['authorization'];
 const cronSecret = process.env.CRON_SECRET;
 if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
  return res.status(401).json({ error: 'Unauthorized' });
 }

 if (!SUPABASE_SERVICE_KEY) {
  return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY env var' });
 }

 const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

 console.log(' Fantasy Life — Country GDP + Olympics Update\n');

 // Find active season
 const { data: season } = await supabase
  .from('seasons')
  .select('year')
  .eq('status', 'active')
  .single();

 if (!season) {
  return res.status(200).json({ message: 'No active season found' });
 }

 // Get Country picks
 const { data: picks } = await supabase
  .from('picks')
  .select('id, member_id, pick, base, bonus')
  .eq('season_year', season.year)
  .eq('category', 'Country');

 if (!picks || picks.length === 0) {
  return res.status(200).json({ message: 'No Country picks found' });
 }

 const results = { gdp: null, olympics: null };

 // ── GDP UPDATE ──
 console.log(' Fetching GDP data from World Bank...');
 const isoCodes = picks
  .map(p => getCountryISO(p.pick))
  .filter(Boolean);

 const uniqueISO = [...new Set(isoCodes)];
 const gdpData = await fetchGDPData(uniqueISO);

 if (gdpData) {
  // Map picks to GDP values
  const gdpResults = picks.map(p => {
   const iso = getCountryISO(p.pick);
   const gdp = iso && gdpData[iso] ? gdpData[iso].gdpGrowth : null;
   return { ...p, gdpGrowth: gdp, iso };
  });

  // Only update if we got GDP data for at least some countries
  const withData = gdpResults.filter(r => r.gdpGrowth !== null);

  if (withData.length > 0) {
   // Rank by GDP growth (highest = rank 1)
   gdpResults.sort((a, b) => (b.gdpGrowth || -999) - (a.gdpGrowth || -999));
   const totalMembers = picks.length;

   let updated = 0;
   const rankings = [];

   for (let i = 0; i < gdpResults.length; i++) {
    const r = gdpResults[i];
    const newBase = totalMembers - i;

    if (r.gdpGrowth !== null) {
     const { error } = await supabase
      .from('picks')
      .update({
       base: newBase,
       metric: r.gdpGrowth,
       record: `${r.gdpGrowth}% GDP`,
       updated_at: new Date().toISOString(),
      })
      .eq('id', r.id);

     if (!error) updated++;
    }

    rankings.push({
     rank: i + 1,
     member: r.member_id,
     country: r.pick,
     gdpGrowth: r.gdpGrowth !== null ? `${r.gdpGrowth}%` : 'No data',
     base: newBase,
    });
   }

   console.log(` GDP: Updated ${updated}/${picks.length} countries`);
   results.gdp = { status: 'updated', updated, rankings };
  } else {
   console.log(' GDP: No data available for any picked countries — preserving scores');
   results.gdp = { status: 'skipped', reason: 'no data for picked countries' };
  }
 } else {
  console.log(' GDP: World Bank API unavailable — preserving existing scores');
  results.gdp = { status: 'skipped', reason: 'World Bank API error' };
 }

 // ── OLYMPICS UPDATE ──
 // Only run during actual Olympic years and months
 // Winter Olympics: every 4 years starting 2026 (2026, 2030, 2034, ...)
 // Summer Olympics: every 4 years starting 2028 (2028, 2032, 2036, ...)
 const now = new Date();
 const year = now.getFullYear();
 const month = now.getMonth() + 1;

 const isWinterOlympicYear = (year - 2026) % 4 === 0;
 const isSummerOlympicYear = (year - 2028) % 4 === 0;
 const isWinterOlympicWindow = isWinterOlympicYear && (month === 2 || month === 3);
 const isSummerOlympicWindow = isSummerOlympicYear && (month === 7 || month === 8);
 const isOlympicWindow = isWinterOlympicWindow || isSummerOlympicWindow;

 if (isOlympicWindow) {
  console.log('\n Checking Olympic medal counts...');
  const medalData = await fetchOlympicMedals();

  if (medalData) {
   let olympicsUpdated = 0;
   const medalRankings = [];

   for (const pick of picks) {
    const medals = matchOlympicMedals(pick.pick, medalData);

    if (medals) {
     // Determine rank position in medal table
     const rankIdx = medalData.findIndex(m => m.noc === COUNTRY_NOC[pick.pick]);
     const medalRank = rankIdx >= 0 ? rankIdx + 1 : null;
     const bonusPts = OLYMPIC_BONUS[medalRank] || 0;

     // Update country_olympics table
     const { error } = await supabase
      .from('country_olympics')
      .upsert({
       pick_id: pick.id,
       medal_rank: medalRank,
       gold: medals.gold,
       silver: medals.silver,
       bronze: medals.bronze,
       pts: bonusPts,
       note: medalRank && medalRank <= 5
        ? `#${medalRank} by total medals (${medals.total})`
        : medals.total > 0
         ? `${medals.total} medals, outside top 5`
         : 'No medals',
      }, { onConflict: 'pick_id' });

     if (!error) {
      // Update bonus on picks table
      await supabase
       .from('picks')
       .update({
        bonus: bonusPts,
        bonus_note: bonusPts > 0
         ? `#${medalRank} by total medals (${medals.total})`
         : '',
        updated_at: new Date().toISOString(),
       })
       .eq('id', pick.id);

      olympicsUpdated++;
     }

     medalRankings.push({
      member: pick.member_id,
      country: pick.pick,
      gold: medals.gold,
      silver: medals.silver,
      bronze: medals.bronze,
      total: medals.total,
      medalRank,
      bonusPts,
     });
    } else {
     medalRankings.push({
      member: pick.member_id,
      country: pick.pick,
      gold: 0, silver: 0, bronze: 0, total: 0,
      medalRank: null,
      bonusPts: 0,
     });
    }
   }

   console.log(` Olympics: Updated ${olympicsUpdated}/${picks.length} countries`);
   results.olympics = { status: 'updated', updated: olympicsUpdated, rankings: medalRankings };
  } else {
   console.log(' Olympics: No medal data found — preserving existing');
   results.olympics = { status: 'skipped', reason: 'no medal data found' };
  }
 } else {
  console.log('\n Olympics: Not in Olympic window — skipping');
  results.olympics = { status: 'skipped', reason: 'not Olympic season' };
 }

 const summary = {
  message: 'Country update complete',
  season: season.year,
  timestamp: new Date().toISOString(),
  results,
 };

 console.log('\n Done!');
 return res.status(200).json(summary);
};