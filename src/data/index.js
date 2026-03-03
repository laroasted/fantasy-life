// Fantasy Life Hub — Data assembler
// Imports all 15 category detail arrays and exports them together.
// Also provides the build2025() function to create the default season.
import { NFL_DETAIL } from './nfl';
import { MLB_DETAIL } from './mlb';
import { NBA_DETAIL } from './nba';
import { NHL_DETAIL } from './nhl';
import { NCAAF_DETAIL } from './ncaaf';
import { NCAAB_DETAIL } from './ncaab';
import { MLS_DETAIL } from './mls';
import { TENNIS_DETAIL } from './tennis';
import { GOLF_DETAIL } from './golf';
import { F1_DETAIL } from './f1';
import { ACTOR_DETAIL } from './actor';
import { ACTRESS_DETAIL } from './actress';
import { MUSICIAN_DETAIL } from './musician';
import { COUNTRY_DETAIL } from './country';
import { STOCK_DETAIL } from './stock';
import { CATEGORY_ORDER } from '../constants/categories';
import { DRAFT_MEMBERS } from '../constants/members';

// All detailed data keyed by category name
export const ALL_DETAIL_2025 = {
 NFL: NFL_DETAIL,
 MLB: MLB_DETAIL,
 NBA: NBA_DETAIL,
 NHL: NHL_DETAIL,
 NCAAF: NCAAF_DETAIL,
 NCAAB: NCAAB_DETAIL,
 MLS: MLS_DETAIL,
 Tennis: TENNIS_DETAIL,
 Golf: GOLF_DETAIL,
 F1: F1_DETAIL,
 Actor: ACTOR_DETAIL,
 Actress: ACTRESS_DETAIL,
 Musician: MUSICIAN_DETAIL,
 Country: COUNTRY_DETAIL,
 Stock: STOCK_DETAIL,
};

// Re-export individual arrays for direct imports
export {
 NFL_DETAIL, MLB_DETAIL, NBA_DETAIL, NHL_DETAIL,
 NCAAF_DETAIL, NCAAB_DETAIL, MLS_DETAIL,
 TENNIS_DETAIL, GOLF_DETAIL, F1_DETAIL,
 ACTOR_DETAIL, ACTRESS_DETAIL, MUSICIAN_DETAIL,
 COUNTRY_DETAIL, STOCK_DETAIL,
};

/**
* Build the default 2025 season object.
* This is used as the fallback when no saved season exists in storage.
*
* The returned object has TWO data layers:
*  - categories: summary scores { owner, pick, base, bonus, total }
*  - detailedData: full arrays with rounds/films/songs/majors/olympics/etc.
*
* The Scoreboard reads categories for rankings and detailedData for expanded views.
* The Settings tab edits both layers so they stay in sync.
*
* IMPORTANT: locks starts empty {} for every new season.
* Locks are added by the commissioner during the season via Settings.
*
* @returns {object} Complete season object
*/
export function build2025() {
 const categories = {};
 CATEGORY_ORDER.forEach((key) => {
  const detailArray = ALL_DETAIL_2025[key];
  categories[key] = detailArray.map((entry) => ({
   owner: entry.owner,
   pick: entry.pick,
   base: entry.base,
   bonus: entry.bonus || 0,
   total: entry.total,
  }));
 });

 return {
  year: 2025,
  name: "Fantasy Life 2025",
  draftDate: "2025-03-01T00:00:00Z",
  memberCount: 11,
  members: DRAFT_MEMBERS.map((m) => ({
   id: m.id,
   name: m.name,
   full: m.full,
  })),
  categories,
  detailedData: ALL_DETAIL_2025,
  locks: {},
  status: "active",
 };
}