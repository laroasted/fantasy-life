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
  NCAAF: "10:Win Natl Champ | 7:Lose Natl Champ | 5:Lose Semi | 3:Win BCS Bowl | 2:Lose BCS Bowl | 1:Win Other Bowl",
  NCAAB: "10:Win Natl Champ | 7:Lose Champ | 5:Lose F4 | 3:Lose E8 | 2:Lose S16 | 1:Lose R32",
  MLS: "10:Win MLS Cup | 7:Lose Finals | 5:Lose Conf Final | 3:Lose Semi | 2:Lose 1st Rd",
  Tennis: "3:Win Major | 2:Lose Major Final | 1:Lose Major SF",
  Golf: "3:Win Major | 2:Runner-up Major | 1:Top 5 Major",
  F1: "3:Win Featured GP | 2:2nd Featured GP | 1:3rd Featured GP (AUS, MIA, ATX, LV)",
  Actor: "10:Win Best Actor | 7:Win Supporting | 3:Nom Best Actor | 2:Nom Supporting",
  Actress: "10:Win Best Actress | 7:Win Supporting | 3:Nom Best Actress | 2:Nom Supporting",
  Musician: "7:Best Song/Album Win | 3:Pop/Rock/Rap/New Artist Win | 1:Nomination w/o Win",
  Country: "Olympic Year: 10:Most Medals | 7:2nd | 5:3rd | 3:4th | 2:5th",
  Stock: "No bonus points",
};

// Which categories are "sports" (have playoff rounds)
export const SPORT_CATEGORIES = ["NFL", "MLB", "NBA", "NHL", "NCAAF", "NCAAB", "MLS"];