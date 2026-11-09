// Shared country reference data for the Country draft category — the single
// source of truth for BOTH the draft tool's picker (src/constants/
// pickOptions.js) and the GDP/Olympics scoring cron's name matching
// (api/cron/update-country.js). Previously COUNTRY_ISO3 was duplicated in
// update-country.js alone, with Country left as 100% free-text at draft
// time — nothing stopped a misspelled pick from drafting cleanly and then
// silently never matching during scoring (getCountryISO() logging a
// "no ISO code" warning no one but Vercel's own function logs ever see).
// Importing the one list from both places means a name picked at draft
// time is, by construction, a name the cron can resolve.
//
// Deliberately plain CommonJS (module.exports), not this directory's usual
// `export const` — api/cron/update-country.js is a plain Node function with
// no build step of its own and can only `require()` a CommonJS module. CRA's
// webpack config (ModuleScopePlugin) requires anything src/constants/
// pickOptions.js imports to live inside src/, which rules out a shared file
// at the repo root instead — this file satisfies both constraints at once:
// it lives in src/ (so webpack's import is allowed) and uses CommonJS (so
// Node's require() from api/ can load it directly, no transpilation).
// Webpack's standard CommonJS interop lets pickOptions.js still `import`
// named exports from it normally.

// Country name (and common alias) → ISO 3166-1 alpha-3 code, for matching a
// drafted pick against gdp_forecasts.data's ISO keys. Includes aliases
// (US/USA/America, UK/Great Britain/England, etc.) that resolve to the same
// code as a real country's canonical name — those aliases are intentionally
// NOT all offered as separate options in the draft-time dropdown; see
// CANONICAL_COUNTRIES below, which picks exactly one display name per code.
const COUNTRY_ISO3 = {
  'Norway': 'NOR', 'South Sudan': 'SSD', 'Germany': 'DEU',
  'United States': 'USA', 'Russia': 'RUS', 'India': 'IND',
  'Libya': 'LBY', 'Ethiopia': 'ETH', 'Guyana': 'GUY',
  'Canada': 'CAN', 'Philippines': 'PHL',
  'Sudan': 'SDN', 'Finland': 'FIN', 'Vietnam': 'VNM',
  'Ireland': 'IRL', 'Guinea': 'GIN',
  'US': 'USA', 'USA': 'USA', 'U.S.': 'USA', 'U.S.A.': 'USA',
  'America': 'USA', 'UK': 'GBR', 'United Kingdom': 'GBR',
  'Great Britain': 'GBR', 'England': 'GBR',
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

// Pure aliases in COUNTRY_ISO3 above that share a canonical entry elsewhere
// in the same map (e.g. "US" and "United States" both resolve to USA) —
// excluded from CANONICAL_COUNTRIES below so the dropdown never offers the
// same real country twice under two different names.
const ALIAS_KEYS = new Set([
  'US', 'USA', 'U.S.', 'U.S.A.', 'America',
  'UK', 'Great Britain', 'England',
  'DR Congo', 'DRC',
  'Czechia',
  "Cote d'Ivoire",
  'Korea',
  'Burma',
  'East Timor',
  'UAE',
]);

// One pickable display name per country, alphabetized — this is what
// actually populates the draft tool's Country dropdown.
const CANONICAL_COUNTRIES = Object.keys(COUNTRY_ISO3)
  .filter((name) => !ALIAS_KEYS.has(name))
  .sort((a, b) => a.localeCompare(b));

module.exports = { COUNTRY_ISO3, CANONICAL_COUNTRIES };
