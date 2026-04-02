/**
 * Fantasy Life — Country GDP + Olympics Updater
 * 
 * DATA SOURCE: IMF World Economic Outlook (DataMapper API)
 *   - Indicator: NGDP_RPCH (Real GDP growth, annual percent change)
 *   - Returns forecast/projected GDP for the fantasy year
 *   - Previous version used World Bank (historical actuals only), which
 *     returned stale data 1-2 years behind and missed many countries.
 *
 * FANTASY YEAR: Derived from seasons.year (the active season), not hardcoded.
 *   - Also requests year-1 and year+1 as fallbacks in case IMF hasn't
 *     published the exact year yet.
 *
 * Respects commissioner locks from seasons.locks column.
 *
 * Tiebreaker: countries with the same GDP growth % split/average the base
 * points they collectively occupy.
 */
 
const { createClient } = require('@supabase/supabase-js');
 
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyojbvijcfbyprrlunyn.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
 
// ═══════════════════════════════════════════════════════════════════════
// COMPREHENSIVE COUNTRY → ISO 3166-1 alpha-3 LOOKUP
// The IMF DataMapper API uses these same codes.
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
  // Expanded — every country someone might realistically draft
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
  console.warn('  ⚠ No ISO code found for country: "' + pickName + '" — add it to COUNTRY_ISO3!');
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
 
// ═══════════════════════════════════════════════════════════════════════
// IMF WORLD ECONOMIC OUTLOOK — SDMX API
//
// The DataMapper API (imf.org/external/datamapper/api/v1) returns 403
// from server environments like Vercel. The SDMX REST API is the
// official programmatic endpoint and does NOT block server requests.
//
// SDMX 2.0 endpoint (JSON):
//   http://dataservices.imf.org/REST/SDMX_JSON.svc/CompactData/WEO/{key}
//   Key format: {COUNTRY}.NGDP_RPCH.A
//   Multiple countries joined with +
//
// SDMX 3.0 endpoint (JSON):
//   https://api.imf.org/external/sdmx/3.0/data/WEO/{key}
//   Accept: application/vnd.sdmx.data+json
//
// We try the SDMX 2.0 JSON endpoint first (most battle-tested),
// then fall back to DataMapper if it works.
//
// Response shape (SDMX 2.0 CompactData JSON):
// { CompactData: { DataSet: { Series: [
//   { @REF_AREA: "GIN", @INDICATOR: "NGDP_RPCH", Obs: [
//     { @TIME_PERIOD: "2026", @OBS_VALUE: "10.5" }, ...
//   ] }, ...
// ] } } }
// ═══════════════════════════════════════════════════════════════════════
 
async function fetchIMFData(countryCodes, fantasyYear) {
  // Try SDMX 2.0 first, then DataMapper as fallback
  var result = await fetchIMF_SDMX(countryCodes, fantasyYear);
  if (result) return result;
 
  console.log('  SDMX API failed, trying DataMapper fallback...');
  return await fetchIMF_DataMapper(countryCodes, fantasyYear);
}
 
async function fetchIMF_SDMX(countryCodes, fantasyYear) {
  try {
    var countryKey = countryCodes.join('+');
    var startYear = fantasyYear - 1;
    var endYear = fantasyYear + 1;
 
    var url = 'http://dataservices.imf.org/REST/SDMX_JSON.svc/CompactData/WEO/' +
      countryKey + '.NGDP_RPCH.A' +
      '?startPeriod=' + startYear + '&endPeriod=' + endYear;
 
    console.log('  SDMX API URL: ' + url);
 
    var res = await fetch(url, {
      headers: {
        'User-Agent': 'FantasyLife/1.0',
        'Accept': 'application/json'
      }
    });
 
    if (!res.ok) {
      console.error('  SDMX API returned HTTP ' + res.status);
      return null;
    }
 
    var data = await res.json();
 
    // Navigate SDMX CompactData structure
    var dataset = data && data.CompactData && data.CompactData.DataSet;
    if (!dataset || !dataset.Series) {
      console.error('  SDMX response has no Series data');
      console.error('  Response structure:', JSON.stringify(data).substring(0, 500));
      return null;
    }
 
    // Series can be a single object or array
    var seriesArr = Array.isArray(dataset.Series) ? dataset.Series : [dataset.Series];
    console.log('  SDMX returned ' + seriesArr.length + ' series');
 
    var targetYear = String(fantasyYear);
    var fallback1 = String(fantasyYear - 1);
    var fallback2 = String(fantasyYear + 1);
    var gdpByCountry = {};
 
    for (var series of seriesArr) {
      var iso = series['@REF_AREA'];
      if (!iso || !countryCodes.includes(iso)) continue;
 
      // Obs can be single object or array
      var obs = series.Obs;
      if (!obs) continue;
      var obsArr = Array.isArray(obs) ? obs : [obs];
 
      // Build year→value map
      var yearMap = {};
      for (var o of obsArr) {
        var yr = o['@TIME_PERIOD'];
        var val = o['@OBS_VALUE'];
        if (yr && val) yearMap[yr] = parseFloat(val);
      }
 
      // Priority: fantasy year > year-1 > year+1
      var usedYear = null;
      var value = null;
      if (yearMap[targetYear] != null) { usedYear = targetYear; value = yearMap[targetYear]; }
      else if (yearMap[fallback1] != null) { usedYear = fallback1; value = yearMap[fallback1]; console.log('  ' + iso + ': no ' + targetYear + ' data, using ' + fallback1 + ' fallback'); }
      else if (yearMap[fallback2] != null) { usedYear = fallback2; value = yearMap[fallback2]; console.log('  ' + iso + ': no ' + targetYear + ' data, using ' + fallback2 + ' fallback'); }
 
      if (value != null && usedYear != null) {
        gdpByCountry[iso] = {
          year: parseInt(usedYear),
          gdpGrowth: Math.round(value * 10) / 10,
          isForecast: parseInt(usedYear) >= new Date().getFullYear()
        };
        console.log('  ' + iso + ': ' + gdpByCountry[iso].gdpGrowth + '% (' + usedYear +
          (gdpByCountry[iso].isForecast ? ', forecast' : ', actual') + ')');
      } else {
        console.log('  ' + iso + ': no data for years ' + [fallback1, targetYear, fallback2].join(', '));
      }
    }
 
    if (Object.keys(gdpByCountry).length === 0) {
      console.error('  SDMX: parsed 0 countries from response');
      return null;
    }
 
    return gdpByCountry;
  } catch (err) {
    console.error('  SDMX fetch error:', err.message);
    return null;
  }
}
 
async function fetchIMF_DataMapper(countryCodes, fantasyYear) {
  try {
    var years = [fantasyYear - 1, fantasyYear, fantasyYear + 1];
    var periodsParam = years.join(',');
    var countriesPath = countryCodes.join('/');
 
    var url = 'https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/' +
      countriesPath + '?periods=' + periodsParam;
 
    console.log('  DataMapper URL: ' + url);
 
    var res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
 
    if (!res.ok) {
      console.error('  DataMapper API returned HTTP ' + res.status);
      return null;
    }
 
    var data = await res.json();
    var values = data && data.values && data.values.NGDP_RPCH;
    if (!values) {
      console.error('  DataMapper returned no values');
      return null;
    }
 
    var targetYear = String(fantasyYear);
    var fallback1 = String(fantasyYear - 1);
    var fallback2 = String(fantasyYear + 1);
    var gdpByCountry = {};
 
    for (var iso of countryCodes) {
      var countryData = values[iso];
      if (!countryData) continue;
 
      var usedYear = null;
      var value = null;
      if (countryData[targetYear] != null) { usedYear = targetYear; value = countryData[targetYear]; }
      else if (countryData[fallback1] != null) { usedYear = fallback1; value = countryData[fallback1]; }
      else if (countryData[fallback2] != null) { usedYear = fallback2; value = countryData[fallback2]; }
 
      if (value != null && usedYear != null) {
        gdpByCountry[iso] = {
          year: parseInt(usedYear),
          gdpGrowth: Math.round(parseFloat(value) * 10) / 10,
          isForecast: parseInt(usedYear) >= new Date().getFullYear()
        };
        console.log('  ' + iso + ': ' + gdpByCountry[iso].gdpGrowth + '% (' + usedYear + ')');
      }
    }
 
    return Object.keys(gdpByCountry).length > 0 ? gdpByCountry : null;
  } catch (err) {
    console.error('  DataMapper fetch error:', err.message);
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
  console.log('Data source: IMF World Economic Outlook (NGDP_RPCH)\n');
 
  // ── Load active season ──
  var { data: season } = await supabase
    .from('seasons').select('year, locks').eq('status', 'active').single();
  if (!season) return res.status(200).json({ message: 'No active season found' });
 
  var fantasyYear = season.year;
  var locks = season.locks || {};
  console.log('Season: ' + fantasyYear + ' (GDP target year: ' + fantasyYear + ')');
 
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
  console.log('Found ' + totalMembers + ' Country picks:');
  picks.forEach(function(p) {
    var iso = getCountryISO(p.pick);
    console.log('  ' + (memberNameById[p.member_id] || p.member_id) +
      ': ' + p.pick + ' → ' + (iso || 'UNKNOWN ISO'));
  });
 
  var results = { gdp: null, olympics: null };
 
  // ════════════════════════════════════════════════════════════════════
  // GDP UPDATE (IMF WEO)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n── GDP Update (IMF WEO, target year: ' + fantasyYear + ') ──');
 
  var isoMap = {};
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
  console.log('Requesting ' + uniqueISO.length + ' countries from IMF: ' + uniqueISO.join(', '));
 
  var gdpData = await fetchIMFData(uniqueISO, fantasyYear);
 
  if (gdpData) {
    var gdpResults = picks.map(function(p) {
      var iso = getCountryISO(p.pick);
      var entry = iso && gdpData[iso] ? gdpData[iso] : null;
      return {
        ...p,
        gdpGrowth: entry ? entry.gdpGrowth : null,
        iso: iso,
        dataYear: entry ? entry.year : null,
        isForecast: entry ? entry.isForecast : null
      };
    });
 
    var withData = gdpResults.filter(function(r) { return r.gdpGrowth !== null; });
    var withoutData = gdpResults.filter(function(r) { return r.gdpGrowth === null; });
 
    console.log('\nIMF data found for ' + withData.length + '/' + totalMembers + ' picks:');
    withData.forEach(function(r) {
      console.log('  ✓ ' + r.pick + ' (' + r.iso + '): ' + r.gdpGrowth + '% (' + r.dataYear + ')');
    });
    if (withoutData.length > 0) {
      console.log('IMF data MISSING for:');
      withoutData.forEach(function(r) {
        console.log('  ✗ ' + r.pick + ' (ISO: ' + (r.iso || 'NONE') + ')');
      });
    }
 
    if (withData.length > 0) {
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
          console.log('  #' + r.rank + ' ' + r.pick + ': ' + r.gdpGrowth + '% → ' +
            r.newBase + ' base pts');
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
 
          // Clean record label — only annotate if data year differs from fantasy year
          var recordLabel = r.gdpGrowth + '% GDP';
          if (r.dataYear !== fantasyYear) {
            recordLabel += ' (' + r.dataYear + ')';
          }
 
          var updateObj = { updated_at: new Date().toISOString() };
          if (!baseLocked) updateObj.base = r.newBase;
          if (!metricLocked) {
            updateObj.metric = r.gdpGrowth;
            updateObj.record = recordLabel;
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
      results.gdp = {
        status: 'updated',
        source: 'IMF WEO (NGDP_RPCH)',
        targetYear: fantasyYear,
        updated: updated,
        total: totalMembers,
        rankings: rankings
      };
    } else {
      console.log('No IMF data found for any picked country');
      results.gdp = { status: 'skipped', reason: 'no IMF data for any picked country' };
    }
  } else {
    console.log('IMF API failed');
    results.gdp = { status: 'skipped', reason: 'IMF API error' };
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
 
      console.log('Olympics: Updated ' + olympicsUpdated + '/' + totalMembers + ' countries');
      results.olympics = { status: 'updated', updated: olympicsUpdated, rankings: medalRankings };
    } else {
      results.olympics = { status: 'skipped', reason: 'no medal data found' };
    }
  } else {
    console.log('\n── Olympics: Not in Olympic window (month=' + month +
      ', year=' + calYear + ') ──');
    results.olympics = { status: 'skipped', reason: 'not Olympic season' };
  }
 
  console.log('\n═══ Done! ═══');
  return res.status(200).json({
    message: 'Country update complete',
    season: fantasyYear,
    source: 'IMF WEO (NGDP_RPCH)',
    timestamp: new Date().toISOString(),
    results: results
  });
};
