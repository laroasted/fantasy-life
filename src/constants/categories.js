// Fantasy Life Hub — Category constants

// Draft categories (used in draft tool for pick selection)
export const DRAFT_CATEGORIES = [
  { id: "nfl", name: "NFL Team", icon: "🏈" },
  { id: "nba", name: "NBA Team", icon: "🏀" },
  { id: "mlb", name: "MLB Team", icon: "⚾" },
  { id: "nhl", name: "NHL Team", icon: "🏒" },
  { id: "ncaaf", name: "NCAA Football", icon: "🏟️" },
  { id: "ncaab", name: "NCAA Basketball", icon: "🎓" },
  { id: "tennis", name: "ATP Tennis", icon: "🎾" },
  { id: "golf", name: "Intl Golfer", icon: "⛳" },
  { id: "f1", name: "F1 Driver", icon: "🏎️" },
  { id: "mls", name: "MLS Soccer", icon: "⚽" },
  { id: "actor", name: "Film Actor", icon: "🎬" },
  { id: "actress", name: "Film Actress", icon: "💫" },
  { id: "musician", name: "Musician", icon: "🎵" },
  { id: "country", name: "Country", icon: "🌍" },
  { id: "stock", name: "Company Stock", icon: "📈" },
];

// Category order for scoreboard display (matches data keys)
export const CATEGORY_ORDER = [
  "NFL", "MLB", "NBA", "NHL", "NCAAF", "NCAAB", "MLS",
  "Tennis", "Golf", "F1", "Actor", "Actress", "Musician",
  "Country", "Stock",
];

// Maps data key (e.g. "NFL") to draft category id (e.g. "nfl")
export const CATEGORY_KEY_TO_ID = {
  NFL: "nfl", NBA: "nba", MLB: "mlb", NHL: "nhl",
  NCAAF: "ncaaf", NCAAB: "ncaab", MLS: "mls",
  Tennis: "tennis", Golf: "golf", F1: "f1",
  Actor: "actor", Actress: "actress", Musician: "musician",
  Country: "country", Stock: "stock",
};

// Short labels for scoreboard pills
export const CATEGORY_LABELS = {
  NFL: "🏈 NFL",
  MLB: "⚾ MLB",
  NBA: "🏀 NBA",
  NHL: "🏒 NHL",
  NCAAF: "🏟️ NCAAF",
  NCAAB: "🎓 NCAAB",
  MLS: "⚽ MLS",
  Tennis: "🎾 Tennis",
  Golf: "⛳ Golf",
  F1: "🏎️ F1",
  Actor: "🎬 Actor",
  Actress: "💫 Actress",
  Musician: "🎵 Music",
  Country: "🌍 Country",
  Stock: "📈 Stock",
};

// Metric labels shown in category detail views
export const CATEGORY_METRICS = {
  NFL: "End of Regular Season Win %",
  MLB: "End of Regular Season Win %",
  NBA: "End of Regular Season Win %",
  NHL: "End of Regular Season Standings Points",
  NCAAF: "End-of-Regular-Season AP Pts (pre-CFP)",
  NCAAB: "End-of-Regular-Season AP Pts (pre-Tournament)",
  MLS: "End of Regular Season Standings Points",
  Tennis: "Post Australian Open World Ranking Pts",
  Golf: "Post TOUR Championship World Ranking",
  F1: "Season End Driver Ranking",
  Actor: "BO($M) × RT%",
  Actress: "BO($M) × RT%",
  Musician: "Billboard Hot 100 Weeks",
  Country: "GDP Growth %",
  Stock: "% Change (dividends reinvested)",
};

// Bonus rules displayed below category scoreboard
export const CATEGORY_BONUS_RULES = {
  NFL: "10:Win SB | 7:Lose SB | 5:Lose Conf Champ | 3:Lose Div | 2:Lose WC | 1:Most Pro Bowl",
  MLB: "10:Win WS | 7:Lose WS | 5:Lose LCS | 3:Lose LDS | 2:Lose WC | 1:Most AS Noms",
  NBA: "10:Win Finals | 7:Lose Finals | 5:Lose Conf Champ | 3:Lose 2nd Rd | 2:Lose 1st Rd | 1:Most AS",
  NHL: "10:Win Cup | 7:Lose Cup Final | 5:Lose Semi | 3:Lose 2nd Rd | 2:Lose 1st Rd",
  NCAAF: "10:Win Natl Champ | 7:Lose Natl Champ | 5:Lose Semi | 3:Lose QF | 2:Lose 1st Rd | 1:Win Other Bowl",
  NCAAB: "10:Win Natl Champ | 7:Lose Champ | 5:Lose F4 | 3:Lose E8 | 2:Lose S16 | 1:Lose R32",
  MLS: "10:Win MLS Cup | 7:Lose Finals | 5:Lose Conf Final | 3:Lose Semi | 2:Lose 1st Rd",
  // ── CORRECTED per Constitution Section 3.2 ──
  Tennis: "5:Win Major | 3:Lose Major Final | 2:Lose Major SF",
  Golf: "5:Win Major | 3:Runner-up Major | 2:Top 10 Major",
  // ─────────────────────────────────────────────
  F1: "3:Win Featured GP | 2:2nd Featured GP | 1:3rd Featured GP (AUS, MIA, ATX, LV)",
  Actor: "10:Win Best Actor | 7:Win Supporting | 3:Nom Best Actor | 2:Nom Supporting",
  Actress: "10:Win Best Actress | 7:Win Supporting | 3:Nom Best Actress | 2:Nom Supporting",
  Musician: "7:Best Song/Album Win | 3:Pop/Rock/Rap/New Artist Win | 1:Nomination w/o Win",
  Country: "Olympic Year: 10:Most Medals | 7:2nd | 5:3rd | 3:4th | 2:5th",
  Stock: "No bonus points",
};

// Which categories are "sports" (have playoff rounds)
export const SPORT_CATEGORIES = ["NFL", "MLB", "NBA", "NHL", "NCAAF", "NCAAB", "MLS"];

// Category color-coding (Calendar's event dots/badges) — generated, not
// picked by feel from a framework's default swatches. The previous values
// were assorted Tailwind stops chosen per category "by eye," which is how
// NCAAF and NCAAB silently ended up the exact same yellow and F1 and MLB
// the exact same red — two categories becoming visually indistinguishable
// on the one screen whose whole job is letting a glance tell them apart.
// This set instead comes from one formula (see
// scripts/gen-category-colors.js if that's ever rerun): HSL with fixed
// saturation 68% / lightness 54%, hue stepped at 360/16 = 22.5° starting
// at 10.5° — chosen, like MEMBER_COLORS' formula, to clear this app's own
// semantic hues (theme.yel/grn/up/down/you/acc) so a category color is
// never mistaken for a win/loss/lock/"you" cue. "General" (calendar-only,
// not a draftable category) is deliberately NOT part of this formula — it
// marks league-wide events (draft day, etc.), so it intentionally reuses
// the brand accent (theme.acc) rather than getting its own generated hue.
export const CATEGORY_COLORS = {
  NFL: "#d9573a",      // hue 11
  MLB: "#d9923a",      // hue 33
  NBA: "#d9cf3a",      // hue 56
  NHL: "#aad93a",      // hue 78
  NCAAF: "#6cd93a",    // hue 101
  NCAAB: "#3ad942",    // hue 123
  MLS: "#3ad97f",      // hue 146
  Tennis: "#3ad9ba",   // hue 168
  Golf: "#3abcd9",     // hue 191
  F1: "#3a82d9",       // hue 213
  Actor: "#3a45d9",    // hue 236
  Actress: "#6a3ad9",  // hue 258
  Musician: "#a73ad9", // hue 281
  Country: "#d93ad1",  // hue 303
  Stock: "#d93a94",    // hue 326
  Film: "#d93a5a",     // hue 348 — calendar-only (film releases), not a draftable category
};
