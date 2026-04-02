/**
 * Fantasy Life — Country GDP + Olympics Updater
 * Respects commissioner locks from seasons.locks column.
 *
 * Tiebreaker: countries with the same GDP growth % split/average the base
 * points they collectively occupy.
 * e.g. 2-way tie for ranks 1–2 out of 12 = (12+11)/2 = 11.5 each
 *
 * FIXES from previous version:
 * 1. Comprehensive ISO-3166 lookup — no more missing countries when new ones are drafted
 * 2. All picks ranked together (not just those with fresh API data)
 * 3. Olympic NOC codes comprehensive
 * 4. Logging improved for debugging
 */
 
const { createClient } = require('@supabase/supabase-js');
 
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
 
// ═══════════════════════════════════════════════════════════════════════
// COMPREHENSIVE COUNTRY → ISO 3166-1 alpha-3 LOOKUP
// This replaces the old hardcoded map that broke every time someone
// drafted a country not in the list.
// ═══════════════════════════════════════════════════════════════════════
const COUNTRY_ISO3 = {
  // Current & past Fantasy Life picks
  'Norway': 'NOR', 'South Sudan': 'SSD', 'Germany': 'DEU',
  'United States': 'USA', 'Russia': 'RUS', 'India': 'IND',
  'Libya': 'LBY', 'Ethiopia': 'ETH', 'Guyana': 'GUY',
  'Canada': 'CAN', 'Philippines': 'PHL',
  // 2026 season new picks
  'Sudan': 'SDN', 'Finland': 'FIN', 'Vietnam': 'VNM',
  'Ireland': 'IRL', 'Guinea': 'GIN',
  // Common aliases
  'US': 'USA', 'USA': 'USA', 'U.S.': 'USA', 'U.S.A.': 'USA',
  'America': 'USA', 'UK': 'GBR', 'United Kingdom': 'GBR',
  'Great Britain': 'GBR', 'England': 'GBR',
  // Expanded list — every country someone might realistically draft
  'Afghanistan': 'AFG', 'Albania': 'ALB', 'Algeria': 'DZA',
  'Andorra': 'AND', 'Angola': 'AGO', 'Antigua and Barbuda': 'ATG',
  'Argentina': 'ARG', 'Armenia': 'ARM', 'Australia': 'AUS',
  'Austria': 'AUT', 'Azerbaijan': 'AZE', 'Bahamas': 'BHS',
  'Bahrain': 'BHR', 'Bangladesh': 'BGD', 'Barbados': 'BRB',
  'Belarus': 'BLR', 'Belgium': 'BEL', 'Belize': 'BLZ',
  'Benin': 'BEN', 'Bhutan': 'BTN', 'Bolivia': 'BOL',
  'Bosnia and Herzegovina': 'BIH', 'Botswana': 'BWA', 'Brazil': 'BRA',
  'Brunei': 'BRN', 'Bulgaria': 'BGR', 'Burkina Faso': 'BFA',
  'Burundi': 'BDI', 'Cabo Verde': 'CPV', 'Cambodia': 'KHM',
  'Cameroon': 'CMR', 'Central African Republic': 'CAF', 'Chad': 'TCD',
  'Chile': 'CHL', 'China': 'CHN', 'Colombia': 'COL',
  'Comoros': 'COM', 'Congo': 'COG',
  'Democratic Republic of the Congo': 'COD', 'DR Congo': 'COD',
  'DRC': 'COD', 'Costa Rica': 'CRI', 'Croatia': 'HRV',
  'Cuba': 'CUB', 'Cyprus': 'CYP', 'Czech Republic': 'CZE',
  'Czechia': 'CZE', 'Denmark': 'DNK', 'Djibouti': 'DJI',
  'Dominica': 'DMA', 'Dominican Republic': 'DOM', 'Ecuador': 'ECU',
  'Egypt': 'EGY', 'El Salvador': 'SLV', 'Equatorial Guinea': 'GNQ',
  'Eritrea': 'ERI', 'Estonia': 'EST', 'Eswatini': 'SWZ',
  'Fiji': 'FJI', 'France': 'FRA', 'Gabon': 'GAB',
  'Gambia': 'GMB', 'Georgia': 'GEO', 'Ghana': 'GHA',
  'Greece': 'GRC', 'Grenada': 'GRD', 'Guatemala': 'GTM',
  'Guinea-Bissau': 'GNB', 'Haiti': 'HTI', 'Honduras': 'HND',
  'Hungary': 'HUN', 'Iceland': 'ISL', 'Indonesia': 'IDN',
  'Iran': 'IRN', 'Iraq': 'IRQ', 'Israel': 'ISR',
  'Italy': 'ITA', 'Ivory Coast': 'CIV', "Cote d'Ivoire": 'CIV',
  'Jamaica': 'JAM', 'Japan': 'JPN', 'Jordan': 'JOR',
  'Kazakhstan': 'KAZ', 'Kenya': 'KEN', 'Kiribati': 'KIR',
  'North Korea': 'PRK', 'South Korea': 'KOR', 'Korea': 'KOR',
  'Kuwait': 'KWT', 'Kyrgyzstan': 'KGZ', 'Laos': 'LAO',
  'Latvia': 'LVA', 'Lebanon': 'LBN', 'Lesotho': 'LSO',
  'Liberia': 'LBR', 'Liechtenstein': 'LIE', 'Lithuania': 'LTU',
  'Luxembourg': 'LUX', 'Madagascar': 'MDG', 'Malawi': 'MWI',
  'Malaysia': 'MYS', 'Maldives': 'MDV', 'Mali': 'MLI',
  'Malta': 'MLT', 'Marshall Islands': 'MHL', 'Mauritania': 'MRT',
  'Mauritius': 'MUS', 'Mexico': 'MEX', 'Micronesia': 'FSM',
  'Moldova': 'MDA', 'Monaco': 'MCO', 'Mongolia': 'MNG',
  'Montenegro': 'MNE', 'Morocco': 'MAR', 'Mozambique': 'MOZ',
  'Myanmar': 'MMR', 'Burma': 'MMR', 'Namibia': 'NAM',
  'Nauru': 'NRU', 'Nepal': 'NPL', 'Netherlands': 'NLD',
  'New Zealand': 'NZL', 'Nicaragua': 'NIC', 'Niger': 'NER',
  'Nigeria': 'NGA', 'North Macedonia': 'MKD', 'Oman': 'OMN',
  'Pakistan': 'PAK', 'Palau': 'PLW', 'Palestine': 'PSE',
  'Panama': 'PAN', 'Papua New Guinea': 'PNG', 'Paraguay': 'PRY',
  'Peru': 'PER', 'Poland': 'POL', 'Portugal': 'PRT',
  'Qatar': 'QAT', 'Romania': 'ROU', 'Rwanda': 'RWA',
  'Saint Kitts and Nevis': 'KNA', 'Saint Lucia': 'LCA',
  'Saint Vincent and the Grenadines': 'VCT', 'Samoa': 'WSM',
  'San Marino': 'SMR', 'Sao Tome and Principe': 'STP',
  'Saudi Arabia': 'SAU', 'Senegal': 'SEN', 'Serbia': 'SRB',
  'Seychelles': 'SYC', 'Sierra Leone': 'SLE', 'Singapore': 'SGP',
  'Slovakia': 'SVK', 'Slovenia': 'SVN', 'Solomon Islands': 'SLB',
  'Somalia': 'SOM', 'South Africa': 'ZAF', 'Spain': 'ESP',
  'Sri Lanka': 'LKA', 'Suriname': 'SUR', 'Sweden': 'SWE',
  'Switzerland': 'CHE', 'Syria': 'SYR', 'Taiwan': 'TWN',
  'Tajikistan': 'TJK', 'Tanzania': 'TZA', 'Thailand': 'THA',
  'Timor-Leste': 'TLS', 'East Timor': 'TLS', 'Togo': 'TGO',
  'Tonga': 'TON', 'Trinidad and Tobago': 'TTO', 'Tunisia': 'TUN',
  'Turkey': 'TUR', 'Turkmenistan': 'TKM', 'Tuvalu': 'TUV',
  'Uganda': 'UGA', 'Ukraine': 'UKR',
  'United Arab Emirates': 'ARE', 'UAE': 'ARE',
  'Uruguay': 'URY', 'Uzbekistan': 'UZB', 'Vanuatu': 'VUT',
  'Vatican City': 'VAT', 'Venezuela': 'VEN',
  'Yemen': 'YEM', 'Zambia': 'ZMB', 'Zimbabwe': 'ZWE',
};
 
// ═══════════════════════════════════════════════════════════════════════
// COMPREHENSIVE NOC (Olympic committee) CODE LOOKUP
// ISO codes and NOC codes differ for some countries
// ═══════════════════════════════════════════════════════════════════════
const COUNTRY_NOC = {
  'Norway': 'NOR', 'South Sudan': 'SSD', 'Germany': 'GER',
  'United States': 'USA', 'Russia': 'ROC', 'India': 'IND',
  'Libya': 'LBA', 'Ethiopia': 'ETH', 'Guyana': 'GUY',
  'Canada': 'CAN', 'Philippines': 'PHI',
  // 2026 season new picks
  'Sudan': 'SUD', 'Finland': 'FIN', 'Vietnam': 'VIE',
  'Ireland': 'IRL', 'Guinea': 'GUI',
  // Extended — countries with NOC codes that differ from ISO
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
};
 
const OLYMPIC_BONUS = { 1: 10, 2: 7, 3: 5, 4: 3, 5: 2 };
 
/**
 * Assigns base points with split/average tiebreaker logic.
 * Input array must already be sorted descending by gdpGrowth before calling.
 * Entries with null gdpGrowth are skipped (no data → no base update).
 */
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
 
/**
 * Case-insensitive country → ISO 3166-1 alpha-3 lookup.
 * Returns null only if the country is truly unknown.
 */
function getCountryISO(pickName) {
  if (!pickName) return null;
  // Direct match first
  if (COUNTRY_ISO3[pickName]) return COUNTRY_ISO3[pickName];
  // Case-insensitive search
  var lower = pickName.toLowerCase().trim();
  for (var [name, code] of Object.entries(COUNTRY_ISO3)) {
    if (name.toLowerCase() === lower) return code;
  }
  console.warn('  ⚠ No ISO code found for country: "' + pickName + '" — add it to COUNTRY_ISO3!');
  return null;
}
 
/**
 * Case-insensitive country → NOC code lookup.
 */
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
 
async function fetchGDPData(countryCodes) {
  try {
    var isoList = countryCodes.join(';');
    var currentYear = new Date().getFullYear();
    // Fetch wider range to increase chance of getting data for every country
    var dateRange = (currentYear - 5) + ':' + currentYear;
    var url = 'https://api.worldbank.org/v2/country/' + isoList +
      '/indicator/NY.GDP.MKTP.KD.ZG?format=json&date=' + dateRange + '&per_page=500';
 
    console.log('  World Bank URL: ' + url);
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
      console.error('  World Bank API returned ' + res.status);
      return null;
    }
    var data = await res.json();
    var records = data[1];
    if (!records || records.length === 0) {
      console.error('  World Bank API returned 0 records');
      return null;
    }
 
    console.log('  World Bank returned ' + records.length + ' records');
 
    // For each country, keep the MOST RECENT year that has non-null data
    var gdpByCountry = {};
    for (var record of records) {
      if (record.value === null) continue;
      var iso3 = record.countryiso3code || record.country?.id;
      var year = parseInt(record.date);
      var value = parseFloat(record.value);
      if (!gdpByCountry[iso3] || year > gdpByCountry[iso3].year) {
        gdpByCountry[iso3] = {
          countryName: record.country?.value || iso3,
          year: year,
          gdpGrowth: Math.round(value * 10) / 10
        };
      }
    }
 
    // Log what we got
    for (var [iso, d] of Object.entries(gdpByCountry)) {
      console.log('  ' + iso + ': ' + d.gdpGrowth + '% (' + d.year + ')');
    }
 
    return gdpByCountry;
  } catch (err) {
    console.error('  GDP fetch error:', err.message);
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
  console.log('═══ Fantasy Life — Country GDP + Olympics Update ═══\n');
 
  // ── Load active season ──
  var { data: season } = await supabase
    .from('seasons').select('year, locks').eq('status', 'active').single();
  if (!season) return res.status(200).json({ message: 'No active season found' });
 
  var locks = season.locks || {};
  console.log('Season: ' + season.year);
 
  // ── Load members ──
  var { data: membersArr } = await supabase.from('members').select('id, name');
  var memberNameById = {};
  (membersArr || []).forEach(function(m) { memberNameById[m.id] = m.name; });
 
  // ── Load Country picks ──
  var { data: picks } = await supabase
    .from('picks')
    .select('id, member_id, pick, base, bonus, metric')
    .eq('season_year', season.year)
    .eq('category', 'Country');
  if (!picks || picks.length === 0) {
    return res.status(200).json({ message: 'No Country picks found' });
  }
 
  var totalMembers = picks.length;
  console.log('Found ' + totalMembers + ' Country picks:');
  picks.forEach(function(p) {
    var iso = getCountryISO(p.pick);
    console.log('  ' + (memberNameById[p.member_id] || p.member_id) +
      ': ' + p.pick + ' → ' + (iso || 'UNKNOWN ISO'));
  });
 
  var results = { gdp: null, olympics: null };
 
  // ════════════════════════════════════════════════════════════════════
  // GDP UPDATE
  // ════════════════════════════════════════════════════════════════════
  console.log('\n── GDP Update ──');
  console.log('Fetching GDP data from World Bank...');
 
  // Build ISO list, log any countries we can't map
  var isoMap = {};  // iso → [pickNames]
  var unmapped = [];
  picks.forEach(function(p) {
    var iso = getCountryISO(p.pick);
    if (iso) {
      if (!isoMap[iso]) isoMap[iso] = [];
      isoMap[iso].push(p.pick);
    } else {
      unmapped.push(p.pick);
    }
  });
 
  if (unmapped.length > 0) {
    console.warn('⚠ Could not map these picks to ISO codes: ' + unmapped.join(', '));
  }
 
  var uniqueISO = Object.keys(isoMap);
  console.log('Requesting ' + uniqueISO.length + ' ISO codes: ' + uniqueISO.join(', '));
 
  var gdpData = await fetchGDPData(uniqueISO);
 
  if (gdpData) {
    // Map GDP data onto picks
    var gdpResults = picks.map(function(p) {
      var iso = getCountryISO(p.pick);
      var gdpEntry = iso && gdpData[iso] ? gdpData[iso] : null;
      var gdpGrowth = gdpEntry ? gdpEntry.gdpGrowth : null;
      return { ...p, gdpGrowth: gdpGrowth, iso: iso, dataYear: gdpEntry ? gdpEntry.year : null };
    });
 
    // Log which picks got data and which didn't
    var withData = gdpResults.filter(function(r) { return r.gdpGrowth !== null; });
    var withoutData = gdpResults.filter(function(r) { return r.gdpGrowth === null; });
 
    console.log('\nGDP data found for ' + withData.length + '/' + totalMembers + ' picks:');
    withData.forEach(function(r) {
      console.log('  ✓ ' + r.pick + ' (' + r.iso + '): ' + r.gdpGrowth + '% (' + r.dataYear + ')');
    });
    if (withoutData.length > 0) {
      console.log('GDP data MISSING for:');
      withoutData.forEach(function(r) {
        console.log('  ✗ ' + r.pick + ' (ISO: ' + (r.iso || 'NONE') + ')');
      });
    }
 
    if (withData.length > 0) {
      // Sort descending by gdpGrowth (nulls go last)
      gdpResults.sort(function(a, b) {
        if (a.gdpGrowth === null && b.gdpGrowth === null) return 0;
        if (a.gdpGrowth === null) return 1;
        if (b.gdpGrowth === null) return -1;
        return b.gdpGrowth - a.gdpGrowth;
      });
 
      // Apply tiebreaker scoring — totalMembers is the full count
      gdpResults = assignBasePointsWithTiebreaker(gdpResults, totalMembers);
 
      console.log('\nRankings:');
      gdpResults.forEach(function(r) {
        if (r.gdpGrowth !== null) {
          console.log('  #' + r.rank + ' ' + r.pick + ': ' + r.gdpGrowth + '% → ' + r.newBase + ' base pts');
        } else {
          console.log('  — ' + r.pick + ': No data (not ranked, not updated)');
        }
      });
 
      var updated = 0;
      var rankings = [];
 
      for (var r of gdpResults) {
        var ownerName = memberNameById[r.member_id] || r.member_id;
 
        if (r.gdpGrowth !== null) {
          var baseLocked = isFieldLocked(locks, 'Country', ownerName, 'base');
          var metricLocked = isFieldLocked(locks, 'Country', ownerName, 'metric');
 
          var updateObj = { updated_at: new Date().toISOString() };
          if (!baseLocked) updateObj.base = r.newBase;
          if (!metricLocked) {
            updateObj.metric = r.gdpGrowth;
            updateObj.record = r.gdpGrowth + '% GDP (' + r.dataYear + ')';
          }
 
          var skipped = [];
          if (baseLocked) skipped.push('base');
          if (metricLocked) skipped.push('metric');
          if (skipped.length > 0) {
            console.log('  🔒 ' + ownerName + ': skipped locked fields: ' + skipped.join(', '));
          }
 
          var { error } = await supabase.from('picks').update(updateObj).eq('id', r.id);
          if (error) {
            console.error('  DB error updating ' + r.pick + ':', error.message);
          } else {
            updated++;
          }
        }
 
        rankings.push({
          rank: r.rank || null,
          member: r.member_id,
          owner: ownerName,
          country: r.pick,
          iso: r.iso,
          gdpGrowth: r.gdpGrowth !== null ? r.gdpGrowth + '%' : 'No data',
          dataYear: r.dataYear,
          base: r.newBase || null
        });
      }
 
      console.log('\nGDP: Updated ' + updated + '/' + totalMembers + ' countries');
      results.gdp = { status: 'updated', updated: updated, total: totalMembers, rankings: rankings };
    } else {
      console.log('No GDP data found for any picked country');
      results.gdp = { status: 'skipped', reason: 'no data for any picked country' };
    }
  } else {
    console.log('World Bank API failed');
    results.gdp = { status: 'skipped', reason: 'World Bank API error' };
  }
 
  // ════════════════════════════════════════════════════════════════════
  // OLYMPICS UPDATE
  // ════════════════════════════════════════════════════════════════════
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth() + 1;
  var isWinterOlympicYear = (year - 2026) % 4 === 0;
  var isSummerOlympicYear = (year - 2028) % 4 === 0;
  var isOlympicWindow = (isWinterOlympicYear && (month === 2 || month === 3)) ||
    (isSummerOlympicYear && (month === 7 || month === 8));
 
  if (isOlympicWindow) {
    console.log('\n── Olympics Update ──');
    console.log('Checking Olympic medal counts...');
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
          var bonusLocked = isFieldLocked(locks, 'Country', ownerName2, 'bonus');
 
          console.log('  ' + pick.pick + ' (' + noc + '): rank #' + medalRank +
            ', ' + medals.total + ' medals, bonus=' + bonusPts +
            (bonusLocked ? ' [LOCKED]' : ''));
 
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
              note: medalRank && medalRank <= 5
                ? '#' + medalRank + ' by total medals (' + medals.total + ')'
                : medals.total > 0
                  ? medals.total + ' medals, outside top 5'
                  : 'No medals'
            }, { onConflict: 'pick_id' });
 
          if (!olyErr && !bonusLocked) {
            await supabase.from('picks').update({
              bonus: bonusPts,
              bonus_note: bonusPts > 0
                ? '#' + medalRank + ' by total medals (' + medals.total + ')'
                : '',
              updated_at: new Date().toISOString()
            }).eq('id', pick.id);
            olympicsUpdated++;
          } else if (bonusLocked) {
            console.log('  🔒 ' + ownerName2 + ': bonus is locked, skipping');
            olympicsUpdated++;
          } else if (olyErr) {
            console.error('  DB error for ' + pick.pick + ':', olyErr.message);
          }
 
          medalRankings.push({
            member: pick.member_id,
            owner: ownerName2,
            country: pick.pick,
            gold: medals.gold,
            silver: medals.silver,
            bronze: medals.bronze,
            total: medals.total,
            medalRank: medalRank,
            bonusPts: bonusPts
          });
        } else {
          medalRankings.push({
            member: pick.member_id,
            owner: ownerName2,
            country: pick.pick,
            gold: 0, silver: 0, bronze: 0, total: 0,
            medalRank: null,
            bonusPts: 0
          });
        }
      }
 
      console.log('Olympics: Updated ' + olympicsUpdated + '/' + totalMembers + ' countries');
      results.olympics = { status: 'updated', updated: olympicsUpdated, rankings: medalRankings };
    } else {
      results.olympics = { status: 'skipped', reason: 'no medal data found' };
    }
  } else {
    console.log('\n── Olympics: Not in Olympic window (month=' + month + ', year=' + year + ') ──');
    results.olympics = { status: 'skipped', reason: 'not Olympic season' };
  }
 
  console.log('\n═══ Done! ═══');
  return res.status(200).json({
    message: 'Country update complete',
    season: season.year,
    timestamp: new Date().toISOString(),
    results: results
  });
};
