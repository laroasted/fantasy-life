import { useState, useEffect } from "react";
import { CATEGORY_ORDER, CATEGORY_LABELS, SPORT_CATEGORIES } from "../constants/categories";
import { MEMBER_COLORS } from "../constants/members";
import { theme, cardStyle, inputStyle, buttonStyle } from "../constants/theme";

// ─── Which type of category is this? ───
var FILM_CATS = ["Actor", "Actress"];
var MUSIC_CATS = ["Musician"];
var EVENT_CATS = ["Tennis", "Golf", "F1"];
var COUNTRY_CATS = ["Country"];
var STOCK_CATS = ["Stock"];

function catType(cat) {
 if (SPORT_CATEGORIES.includes(cat)) return "sport";
 if (FILM_CATS.includes(cat)) return "film";
 if (MUSIC_CATS.includes(cat)) return "music";
 if (EVENT_CATS.includes(cat)) return "event";
 if (COUNTRY_CATS.includes(cat)) return "country";
 if (STOCK_CATS.includes(cat)) return "stock";
 return "sport";
}

// ─── Blank row templates when you click "+ Add" ───
function newDetailRow(type) {
 switch (type) {
  case "sport": return { round: "New Round", opponent: "TBD", result: "\u2014", series: "\u2014", pts: 0, note: "" };
  case "film": return { title: "New Film", date: "", bo: 0, rt: 0, score: 0, note: "" };
  case "music-song": return { title: "New Song", weeks: 0, numOneWeeks: 0, note: "" };
  case "music-grammy": return { category: "New Category", result: "nom", entry: "", pts: 0, note: "" };
  case "event": return { event: "New Event", result: "\u2014", opponent: "\u2014", score: "\u2014", pts: 0, note: "" };
  default: return {};
 }
}

// ─── Small lock/unlock button ───
function LockBtn({ locked, onToggle, size }) {
 if (!size) size = 11;
 return (
  <button onClick={function(e) { e.stopPropagation(); onToggle(); }}
   title={locked ? "Locked \u2014 cron won't overwrite this" : "Click to lock this field"}
   style={{
    background: locked ? "rgba(234,179,8,0.2)" : "rgba(100,116,139,0.1)",
    border: locked ? "1px solid rgba(234,179,8,0.5)" : "1px solid rgba(100,116,139,0.25)",
    borderRadius: 4, padding: locked ? "2px 6px" : "2px 8px", cursor: "pointer",
    fontSize: size, lineHeight: 1.3, color: locked ? "#eab308" : "#64748b",
    transition: "all 0.15s", flexShrink: 0, fontWeight: locked ? 400 : 600,
    letterSpacing: locked ? 0 : 0.3,
   }}>
   {locked ? "\uD83D\uDD12" : "lock"}
  </button>
 );
}

// ═══════════════════════════════════════════════════════════
// MAIN SETTINGS COMPONENT
// ═══════════════════════════════════════════════════════════
export default function SeasonSettings({ seasonData, onSave, isCommissioner, commissionerEmail }) {
 var _a = useState("scores"), mode = _a[0], setMode = _a[1];
 var _b = useState(CATEGORY_ORDER[0]), editCat = _b[0], setEditCat = _b[1];
 var _c = useState({}), edits = _c[0], setEdits = _c[1];
 var _d = useState({}), swaps = _d[0], setSwaps = _d[1];
 var _e = useState({}), bonusNotes = _e[0], setBonusNotes = _e[1];
 var _f = useState({}), detailEdits = _f[0], setDetailEdits = _f[1];
 var _g = useState(false), saved = _g[0], setSaved = _g[1];
 var _h = useState([]), changelog = _h[0], setChangelog = _h[1];
 var _i = useState(window.innerWidth < 640), isMobile = _i[0], setIsMobile = _i[1];
 var _j = useState(null), expandedMember = _j[0], setExpandedMember = _j[1];
 var _k = useState(null), confirmDelete = _k[0], setConfirmDelete = _k[1];

 useEffect(function () {
  var onResize = function () { setIsMobile(window.innerWidth < 640); };
  window.addEventListener("resize", onResize);
  return function () { window.removeEventListener("resize", onResize); };
 }, []);

 if (!seasonData) {
  return <div style={{ textAlign: "center", padding: 40, color: theme.dim }}>No active season to edit.</div>;
 }

 var cats = seasonData.categories || {};
 var detail = seasonData.detailedData || {};
 var members = seasonData.members || [];
 var locks = seasonData.locks || {};

 // ─── Score editing (base/bonus) ───
 function getEditVal(cat, owner, field) {
  var key = cat + "|" + owner + "|" + field;
  if (edits[key] !== undefined) return edits[key];
  var entry = (cats[cat] || []).find(function (x) { return x.owner === owner; });
  return entry ? entry[field] : 0;
 }
 function setEditVal(cat, owner, field, val) {
  setEdits(function (prev) {
   var n = Object.assign({}, prev);
   n[cat + "|" + owner + "|" + field] = val;
   return n;
  });
  setSaved(false);
 }

 // ─── Pick swaps ───
 function getSwapVal(cat, owner) {
  var key = cat + "|" + owner;
  if (swaps[key] !== undefined) return swaps[key];
  var entry = (cats[cat] || []).find(function (x) { return x.owner === owner; });
  return entry ? entry.pick : "";
 }
 function setSwapVal(cat, owner, val) {
  setSwaps(function (prev) {
   var n = Object.assign({}, prev);
   n[cat + "|" + owner] = val;
   return n;
  });
  setSaved(false);
 }

 // ─── Bonus notes ───
 function getBonusNote(cat, owner) {
  var key = cat + "|" + owner;
  if (bonusNotes[key] !== undefined) return bonusNotes[key];
  var entry = (detail[cat] || []).find(function (x) { return x.owner === owner; });
  return entry && entry.bonusNote ? entry.bonusNote : "";
 }
 function setBonusNoteVal(cat, owner, val) {
  setBonusNotes(function (prev) {
   var n = Object.assign({}, prev);
   n[cat + "|" + owner] = val;
   return n;
  });
  setSaved(false);
 }

 // ─── Detail field editing ───
 function getDetailEdit(cat, owner, idx, field, subArray) {
  var key = cat + "|" + owner + "|" + (subArray || "main") + "|" + idx + "|" + field;
  if (detailEdits[key] !== undefined) return detailEdits[key];
  var ct = catType(cat);
  var d = (detail[cat] || []).find(function (x) { return x.owner === owner; });
  if (!d) return "";
  var arr;
  if (subArray === "grammys") arr = d.grammys || [];
  else if (subArray === "songs") arr = d.songs || [];
  else if (ct === "sport") arr = d.rounds || [];
  else if (ct === "film") arr = d.films || [];
  else if (ct === "event") arr = d.majors || [];
  else return "";
  return arr[idx] ? arr[idx][field] : "";
 }
 function setDetailEditVal(cat, owner, idx, field, val, subArray) {
  var key = cat + "|" + owner + "|" + (subArray || "main") + "|" + idx + "|" + field;
  setDetailEdits(function (prev) {
   var n = Object.assign({}, prev);
   n[key] = val;
   return n;
  });
  setSaved(false);
 }

 // ─── Lock toggle ───
 function isLocked(key) { return !!locks[key]; }
 function toggleLock(key) {
  var newSeason = JSON.parse(JSON.stringify(seasonData));
  if (!newSeason.locks) newSeason.locks = {};
  if (newSeason.locks[key]) {
   delete newSeason.locks[key];
  } else {
   newSeason.locks[key] = { at: new Date().toISOString(), by: "commissioner" };
  }
  onSave(newSeason);
 }

 // ─── Add a detail row ───
 function addDetailRow(cat, owner, subArray) {
  var newSeason = JSON.parse(JSON.stringify(seasonData));
  var d = (newSeason.detailedData[cat] || []).find(function (x) { return x.owner === owner; });
  if (!d) return;
  var ct = catType(cat);
  if (ct === "sport") { d.rounds = d.rounds || []; d.rounds.push(newDetailRow("sport")); }
  else if (ct === "film") { d.films = d.films || []; d.films.push(newDetailRow("film")); }
  else if (ct === "music" && subArray === "songs") { d.songs = d.songs || []; d.songs.push(newDetailRow("music-song")); }
  else if (ct === "music" && subArray === "grammys") { d.grammys = d.grammys || []; d.grammys.push(newDetailRow("music-grammy")); }
  else if (ct === "event") { d.majors = d.majors || []; d.majors.push(newDetailRow("event")); }
  setChangelog(function (prev) { return [cat + " \u2014 " + owner + ": added new " + (subArray || ct) + " row"].concat(prev); });
  onSave(newSeason);
 }

 // ─── Delete a detail row ───
 function deleteDetailRow(cat, owner, idx, subArray) {
  var newSeason = JSON.parse(JSON.stringify(seasonData));
  var d = (newSeason.detailedData[cat] || []).find(function (x) { return x.owner === owner; });
  if (!d) return;
  var ct = catType(cat);
  var arr;
  if (subArray === "grammys") arr = d.grammys;
  else if (subArray === "songs") arr = d.songs;
  else if (ct === "sport") arr = d.rounds;
  else if (ct === "film") arr = d.films;
  else if (ct === "event") arr = d.majors;
  if (arr && arr[idx]) {
   var removed = arr[idx];
   var label = removed.title || removed.round || removed.event || removed.category || "row";
   arr.splice(idx, 1);
   setChangelog(function (prev) { return [cat + " \u2014 " + owner + ': deleted "' + label + '"'].concat(prev); });
   if (newSeason.locks) {
    var prefix = cat + "|" + owner + "|";
    Object.keys(newSeason.locks).forEach(function (k) {
     if (k.startsWith(prefix) && (k.includes("|d" + idx + "|") || k.includes("|row" + idx))) {
      delete newSeason.locks[k];
     }
    });
   }
  }
  onSave(newSeason);
  setConfirmDelete(null);
 }

 // ─── Save all pending edits ───
 function applyChanges() {
  var newSeason = JSON.parse(JSON.stringify(seasonData));
  var newCats = newSeason.categories;
  var newDetail = newSeason.detailedData;
  var log = [];

  // 1) Score edits (base/bonus)
  Object.keys(edits).forEach(function (key) {
   var parts = key.split("|");
   var cat = parts[0], owner = parts[1], field = parts[2];
   var newVal = parseFloat(edits[key]) || 0;
   var entry = (newCats[cat] || []).find(function (x) { return x.owner === owner; });
   if (entry) {
    var oldVal = entry[field];
    if (oldVal !== newVal) {
     log.push(cat + " \u2014 " + owner + ": " + field + " " + oldVal + " \u2192 " + newVal);
     entry[field] = newVal;
     entry.total = entry.base + (entry.bonus || 0);
    }
   }
   var detArr = newDetail[cat];
   if (detArr) {
    var dd = detArr.find(function (x) { return x.owner === owner; });
    if (dd) { dd[field] = newVal; dd.total = dd.base + (dd.bonus || 0); }
   }
  });

  // 2) Bonus notes
  Object.keys(bonusNotes).forEach(function (key) {
   var parts = key.split("|");
   var cat = parts[0], owner = parts[1];
   var newNote = bonusNotes[key];
   var detArr = newDetail[cat];
   if (detArr) {
    var dd = detArr.find(function (x) { return x.owner === owner; });
    if (dd) {
     var oldNote = dd.bonusNote || "";
     if (oldNote !== newNote) {
      log.push(cat + " \u2014 " + owner + ': bonusNote "' + oldNote + '" \u2192 "' + newNote + '"');
      dd.bonusNote = newNote;
     }
    }
   }
  });

  // 3) Detail field edits
  Object.keys(detailEdits).forEach(function (key) {
   var parts = key.split("|");
   var cat = parts[0], owner = parts[1], subArray = parts[2], idxStr = parts[3], field = parts[4];
   var idx = parseInt(idxStr);
   var newVal = detailEdits[key];
   var d = (newDetail[cat] || []).find(function (x) { return x.owner === owner; });
   if (!d) return;
   var ct = catType(cat);
   var arr;
   if (subArray === "grammys") arr = d.grammys;
   else if (subArray === "songs") arr = d.songs;
   else if (ct === "sport") arr = d.rounds;
   else if (ct === "film") arr = d.films;
   else if (ct === "event") arr = d.majors;
   if (arr && arr[idx]) {
    var oldVal = arr[idx][field];
    var parsed = (typeof oldVal === "number") ? (parseFloat(newVal) || 0) : newVal;
    if (oldVal !== parsed) {
     var label = arr[idx].title || arr[idx].round || arr[idx].event || arr[idx].category || "row " + idx;
     log.push(cat + " \u2014 " + owner + " \u2014 " + label + ": " + field + ' "' + oldVal + '" \u2192 "' + parsed + '"');
     arr[idx][field] = parsed;
    }
   }
  });

  // 4) Recalculate film scores after edits
  CATEGORY_ORDER.forEach(function (cat) {
   if (!FILM_CATS.includes(cat)) return;
   var detArr = newDetail[cat];
   if (!detArr) return;
   detArr.forEach(function (d) {
    if (d.films) {
     d.films.forEach(function (f) { f.score = (f.bo || 0) * ((f.rt || 0) / 100); });
     d.totalScore = d.films.reduce(function (s, f) { return s + f.score; }, 0);
    }
   });
  });

  // 4b) Auto-recalculate base rankings for Actor, Actress, Musician, Stock
  var autoRankCats = ['Actor', 'Actress', 'Musician', 'Stock'];
  autoRankCats.forEach(function (cat) {
   var catArr = newCats[cat];
   var detArr = newDetail[cat];
   if (!catArr || !detArr) return;

   var memberMetrics = catArr.map(function (entry) {
    var d = detArr.find(function (x) { return x.owner === entry.owner; });
    var metric = 0;

    if (FILM_CATS.includes(cat) && d && d.films) {
     metric = d.films.reduce(function (s, f) { return s + (f.score || 0); }, 0);
    } else if (cat === 'Musician' && d && d.songs) {
     metric = d.songs.reduce(function (s, sg) { return s + (Number(sg.weeks) || 0); }, 0);
    } else if (cat === 'Stock' && d) {
     metric = Number(d.pctChange) || 0;
    }

    return { owner: entry.owner, metric: metric, entry: entry, detail: d };
   });

   memberMetrics.sort(function (a, b) { return b.metric - a.metric; });

   var totalMembers = memberMetrics.length;
   for (var ri = 0; ri < memberMetrics.length; ri++) {
    var mm = memberMetrics[ri];
    var newBase = totalMembers - ri;
    var oldBase = mm.entry.base;
    if (oldBase !== newBase) {
     log.push(cat + ' \u2014 ' + mm.owner + ': base auto-recalculated ' + oldBase + ' \u2192 ' + newBase + ' (metric: ' + Math.round(mm.metric * 100) / 100 + ')');
     mm.entry.base = newBase;
     mm.entry.total = newBase + (mm.entry.bonus || 0);
     if (mm.detail) {
      mm.detail.base = newBase;
      mm.detail.total = newBase + (mm.detail.bonus || 0);
     }
    }
   }
  });

  // 5) Pick swaps
  Object.keys(swaps).forEach(function (key) {
   var parts = key.split("|");
   var cat = parts[0], owner = parts[1];
   var newPick = swaps[key];
   var entry = (newCats[cat] || []).find(function (x) { return x.owner === owner; });
   if (entry && entry.pick !== newPick && newPick.trim()) {
    log.push(cat + " \u2014 " + owner + ': pick "' + entry.pick + '" \u2192 "' + newPick + '"');
    entry.pick = newPick;
    var detArr = newDetail[cat];
    if (detArr) {
     var dd = detArr.find(function (x) { return x.owner === owner; });
     if (dd) dd.pick = newPick;
    }
   }
  });

  if (log.length === 0) { setSaved(true); return; }
  setChangelog(function (prev) { return log.concat(prev); });
  onSave(newSeason);
  setSaved(true);
  setEdits({});
  setSwaps({});
  setBonusNotes({});
  setDetailEdits({});
 }

 // ═══ COMMISSIONER GATE ═══
 if (!isCommissioner) {
  return (
   <div style={{ maxWidth: 500, margin: "0 auto", ...cardStyle, textAlign: "center" }}>
    <div style={{ fontSize: 48, marginBottom: 12 }}>{"\uD83D\uDD10"}</div>
    <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>Commissioner Access Required</h3>
    <p style={{ color: theme.dim, fontSize: 13, marginBottom: 16 }}>
     Sign in from the header with your commissioner email magic link to unlock scoring controls, locks, and corrections.
     </p>
    <div style={{ ...inputStyle, marginBottom: 8, textAlign: "left", opacity: 0.7 }}>
     {commissionerEmail ? commissionerEmail : "No commissioner session detected"}
    </div>
    <button disabled style={{ ...buttonStyle(theme.srf), width: "100%", opacity: 0.6, cursor: "default" }}>Awaiting Commissioner Sign-In</button>
   </div>
  );
 }

 var catEntries = (cats[editCat] || []).sort(function (a, b) { return a.owner.localeCompare(b.owner); });
 var ct = catType(editCat);

 // ─── Which fields to show when editing detail rows ───
 function getDetailFields() {
  switch (ct) {
   case "sport": return [
    { key: "round", label: "Round", type: "text" },
    { key: "opponent", label: "Opp", type: "text" },
    { key: "result", label: "Result", type: "select", options: ["Won", "Lost", "\u2014"] },
    { key: "series", label: "Score", type: "text" },
    { key: "pts", label: "Pts", type: "number" },
    { key: "note", label: "Note", type: "text" },
   ];
   case "film": return [
    { key: "title", label: "Title", type: "text" },
    { key: "date", label: "Date", type: "text" },
    { key: "bo", label: "BO ($M)", type: "number" },
    { key: "rt", label: "RT %", type: "number" },
    { key: "note", label: "Note", type: "text" },
   ];
   case "event": return [
    { key: "event", label: "Event", type: "text" },
    { key: "result", label: "Result", type: "text" },
    { key: "opponent", label: "Opponent", type: "text" },
    { key: "score", label: "Score", type: "text" },
    { key: "pts", label: "Pts", type: "number" },
    { key: "note", label: "Note", type: "text" },
   ];
   default: return [];
  }
 }

 // ─── Renders the detail editor for one member (sport/film/event) ───
 function renderArrayEditor(entry, arr, fields, addLabel, subArray) {
  var owner = entry.owner;
  return (
   <div style={{ padding: "8px 0" }}>
    {arr.length === 0 && <div style={{ padding: 8, color: theme.dim, fontSize: 11 }}>No entries yet.</div>}
    {arr.map(function (row, idx) {
     var rKey = subArray
      ? editCat + "|" + owner + "|" + subArray + "|row" + idx
      : editCat + "|" + owner + "|row" + idx;
     var rowLocked = isLocked(rKey);
     var deleteKey = subArray
      ? editCat + "|" + owner + "|" + subArray + "|" + idx
      : editCat + "|" + owner + "|" + idx;
     return (
      <div key={idx} style={{
       padding: "8px 10px", marginBottom: 4, borderRadius: 8,
       background: rowLocked ? "rgba(234,179,8,0.06)" : "rgba(51,65,85,0.2)",
       border: "1px solid " + (rowLocked ? "rgba(234,179,8,0.3)" : theme.bdr),
      }}>
       <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: theme.txt }}>
         {row.round || row.title || row.event || row.category || "Row " + (idx + 1)}
        </span>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
         <LockBtn locked={rowLocked} onToggle={function () { toggleLock(rKey); }} size={10} />
         <button onClick={function () { setConfirmDelete(deleteKey); }}
          style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)",
           borderRadius: 4, padding: "2px 6px", fontSize: 10, color: "#ef4444", cursor: "pointer" }}>
          {"\u2715"} Delete
         </button>
        </div>
       </div>
       {confirmDelete === deleteKey && (
        <div style={{ padding: "6px 8px", marginBottom: 6, borderRadius: 6,
         background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)",
         display: "flex", gap: 8, alignItems: "center", fontSize: 11 }}>
         <span style={{ color: "#fca5a5" }}>Delete this row?</span>
         <button onClick={function () { deleteDetailRow(editCat, owner, idx, subArray); }}
          style={{ background: "#ef4444", border: "none", borderRadius: 4,
           padding: "3px 8px", fontSize: 10, color: "#fff", cursor: "pointer", fontWeight: 700 }}>
          Yes, delete
         </button>
         <button onClick={function () { setConfirmDelete(null); }}
          style={{ background: theme.srf, border: "1px solid " + theme.bdr, borderRadius: 4,
           padding: "3px 8px", fontSize: 10, color: theme.txt, cursor: "pointer" }}>
          Cancel
         </button>
        </div>
       )}
       <div style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(" + Math.min(fields.length, 4) + ", 1fr)",
        gap: 6,
       }}>
        {fields.map(function (f) {
         var fKey = editCat + "|" + owner + "|d" + idx + "|" + f.key;
         var fLocked = isLocked(fKey);
         var val = getDetailEdit(editCat, owner, idx, f.key, subArray);
         return (
          <div key={f.key}>
           <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
            <label style={{ fontSize: 9, color: theme.dim }}>{f.label}</label>
            <LockBtn locked={fLocked} onToggle={function () { toggleLock(fKey); }} size={9} />
           </div>
           {f.type === "select" ? (
            <select value={val}
             onChange={function (e) { setDetailEditVal(editCat, owner, idx, f.key, e.target.value, subArray); }}
             style={{ ...inputStyle, padding: "4px 6px", fontSize: 11 }}>
             {f.options.map(function (o) { return <option key={o} value={o}>{o}</option>; })}
            </select>
           ) : (
            <input type={f.type === "number" ? "number" : "text"}
             value={val}
             onChange={function (e) { setDetailEditVal(editCat, owner, idx, f.key, e.target.value, subArray); }}
             style={{ ...inputStyle, padding: "4px 6px", fontSize: 11 }} />
           )}
          </div>
         );
        })}
       </div>
      </div>
     );
    })}
    <button onClick={function () { addDetailRow(editCat, entry.owner, subArray); }}
     style={{ ...buttonStyle(theme.srf), width: "100%", marginTop: 6, padding: 8, fontSize: 11,
      border: "1px dashed " + theme.bdr }}>
     + Add {addLabel}
    </button>
   </div>
  );
 }

 // ─── Renders detail editor for one member (dispatches by category type) ───
 function renderDetailEditor(entry) {
  var owner = entry.owner;
  var d = (detail[editCat] || []).find(function (x) { return x.owner === owner; });
  if (!d) return <div style={{ padding: 8, color: theme.dim, fontSize: 11 }}>No detail data available.</div>;

  if (ct === "sport") return renderArrayEditor(entry, d.rounds || [], getDetailFields(), "Round");
  if (ct === "film") return renderArrayEditor(entry, d.films || [], getDetailFields(), "Film");
  if (ct === "event") return renderArrayEditor(entry, d.majors || [], getDetailFields(), "Event");

  if (ct === "music") {
   var songFields = [
    { key: "title", label: "Song", type: "text" },
    { key: "weeks", label: "Weeks", type: "number" },
    { key: "numOneWeeks", label: "#1 Wks", type: "number" },
   ];
   var grammyFields = [
    { key: "category", label: "Category", type: "text" },
    { key: "result", label: "Result", type: "select", options: ["win", "nom"] },
    { key: "pts", label: "Pts", type: "number" },
   ];
   return (
    <div style={{ padding: "8px 0" }}>
     <div style={{ fontSize: 11, fontWeight: 700, color: theme.dim, marginBottom: 4 }}>Billboard Songs</div>
     {renderArrayEditor(entry, d.songs || [], songFields, "Song", "songs")}
     <div style={{ fontSize: 11, fontWeight: 700, color: theme.dim, marginBottom: 4, marginTop: 12 }}>Grammy Events</div>
     {renderArrayEditor(entry, d.grammys || [], grammyFields, "Grammy Event", "grammys")}
    </div>
   );
  }

  if (ct === "country") {
   var gdpKey = editCat + "|" + owner + "|gdp";
   return (
    <div style={{ padding: "8px 0" }}>
     <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
      <div>
       <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
        <label style={{ fontSize: 9, color: theme.dim }}>GDP %</label>
        <LockBtn locked={isLocked(gdpKey)} onToggle={function () { toggleLock(gdpKey); }} size={9} />
       </div>
       <input type="number" step="0.1"
        value={getDetailEdit(editCat, owner, 0, "gdp") || d.gdp || 0}
        onChange={function (e) { setDetailEditVal(editCat, owner, 0, "gdp", e.target.value); }}
        style={{ ...inputStyle, padding: "4px 6px", fontSize: 11 }} />
      </div>
     </div>
     {d.olympics && (
      <div style={{ padding: 8, borderRadius: 6, background: "rgba(51,65,85,0.2)", border: "1px solid " + theme.bdr }}>
       <div style={{ fontSize: 10, fontWeight: 700, color: theme.dim, marginBottom: 4 }}>Olympic Medals</div>
       <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
        {["gold", "silver", "bronze", "rank"].map(function (f) {
         var oKey = editCat + "|" + owner + "|olympics." + f;
         return (
          <div key={f}>
           <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 1 }}>
            <label style={{ fontSize: 8, color: theme.dim }}>{f}</label>
            <LockBtn locked={isLocked(oKey)} onToggle={function () { toggleLock(oKey); }} size={8} />
           </div>
           <input type="number"
            value={getDetailEdit(editCat, owner, 0, f) || (d.olympics ? d.olympics[f] : 0) || 0}
            onChange={function (e) { setDetailEditVal(editCat, owner, 0, f, e.target.value); }}
            style={{ ...inputStyle, padding: "3px 4px", fontSize: 10 }} />
          </div>
         );
        })}
       </div>
      </div>
     )}
    </div>
   );
  }

  if (ct === "stock") {
   return (
    <div style={{ padding: "8px 0" }}>
     <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
      {["openPrice", "closePrice", "pctChange"].map(function (f) {
       var sKey = editCat + "|" + owner + "|" + f;
       return (
        <div key={f}>
         <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
          <label style={{ fontSize: 9, color: theme.dim }}>
           {f === "openPrice" ? "Open $" : f === "closePrice" ? "Close $" : "% Change"}
          </label>
          <LockBtn locked={isLocked(sKey)} onToggle={function () { toggleLock(sKey); }} size={9} />
         </div>
         <input type="number" step="0.01"
          value={getDetailEdit(editCat, owner, 0, f) || d[f] || 0}
          onChange={function (e) { setDetailEditVal(editCat, owner, 0, f, e.target.value); }}
          style={{ ...inputStyle, padding: "4px 6px", fontSize: 11 }} />
        </div>
       );
      })}
     </div>
    </div>
   );
  }

  return null;
 }

 // ═══════════════════════════════════════════════════════════
 // MAIN RENDER
 // ═══════════════════════════════════════════════════════════
 return (
  <div style={{ maxWidth: 800, margin: "0 auto" }}>
   {/* ─── Mode tabs ─── */}
   <div style={{ display: "flex", gap: isMobile ? 3 : 8, marginBottom: 16 }}>
    {[
     { id: "scores", label: isMobile ? "Scores" : "Scores & Bonus" },
     { id: "details", label: isMobile ? "Details" : "Detail Lines" },
     { id: "swaps", label: isMobile ? "Swaps" : "Swap Picks" },
     { id: "locks", label: isMobile ? "Locks" : "Locks (" + Object.keys(locks).length + ")" },
     { id: "log", label: isMobile ? "Log" : "Log" + (changelog.length ? " (" + changelog.length + ")" : "") },
    ].map(function (tab) {
     return (
      <button key={tab.id} onClick={function () { setMode(tab.id); }}
       style={{ ...buttonStyle(mode === tab.id ? theme.acc : theme.srf), flex: 1,
        border: mode === tab.id ? "none" : "1px solid " + theme.bdr,
        fontSize: isMobile ? 11 : 12, padding: isMobile ? "8px 4px" : "10px 12px" }}>
       {tab.label}
      </button>
     );
    })}
   </div>

   {/* ─── Category pills ─── */}
   {mode !== "log" && (
    <div style={{
     display: "flex", flexWrap: isMobile ? "nowrap" : "wrap",
     gap: 4, marginBottom: 16, justifyContent: isMobile ? "flex-start" : "center",
     overflowX: isMobile ? "auto" : "visible",
     WebkitOverflowScrolling: "touch", paddingBottom: isMobile ? 4 : 0,
     msOverflowStyle: "none", scrollbarWidth: "none",
    }}>
     {CATEGORY_ORDER.map(function (k) {
      var lockCount = Object.keys(locks).filter(function (l) { return l.startsWith(k + "|"); }).length;
      return (
       <button key={k} onClick={function () { setEditCat(k); setExpandedMember(null); }}
        style={{ padding: "5px 10px", borderRadius: 20, flexShrink: 0,
         border: "1px solid " + (editCat === k ? "#3b82f6" : "#334155"),
         background: editCat === k ? "#3b82f6" : "#1e293b",
         color: "#f1f5f9", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
         position: "relative" }}>
        {CATEGORY_LABELS[k]}
        {lockCount > 0 && mode === "locks" && (
         <span style={{ position: "absolute", top: -4, right: -4, background: "#eab308",
          color: "#0f172a", borderRadius: 10, padding: "0 4px", fontSize: 8, fontWeight: 800 }}>
          {lockCount}
         </span>
        )}
       </button>
      );
     })}
    </div>
   )}

   {/* ═══ SCORES & BONUS MODE ═══ */}
   {mode === "scores" && (
    <div style={cardStyle}>
     <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>{CATEGORY_LABELS[editCat]} {"\u2014"} Scores & Bonus Notes</h3>
     <p style={{ color: theme.dim, fontSize: 11, margin: "0 0 16px" }}>
      Edit base/bonus points and add a note explaining the bonus. Notes show in the scoreboard breakdown.
     </p>
     <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {catEntries.map(function (entry) {
       var mid = (members.find(function (x) { return x.name === entry.owner; }) || {}).id;
       var baseVal = getEditVal(editCat, entry.owner, "base");
       var bonusVal = getEditVal(editCat, entry.owner, "bonus");
       var total = (parseFloat(baseVal) || 0) + (parseFloat(bonusVal) || 0);
       var bKey = editCat + "|" + entry.owner + "|base";
       var bnKey = editCat + "|" + entry.owner + "|bonus";
       return (
        <div key={entry.owner} style={{
         padding: isMobile ? "10px 12px" : "10px 14px", borderRadius: 8,
         background: "rgba(51,65,85,0.2)", border: "1px solid " + theme.bdr,
        }}>
         <div style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "100px 1fr 1fr 60px",
          gap: isMobile ? 6 : 8, alignItems: isMobile ? "stretch" : "center",
         }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
           <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: MEMBER_COLORS[mid] || theme.txt }}>{entry.owner}</div>
            <div style={{ fontSize: 10, color: theme.dim, overflow: "hidden",
             textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: isMobile ? 180 : 90 }}>{entry.pick}</div>
           </div>
           {isMobile && (
            <div style={{ textAlign: "right" }}>
             <div style={{ fontSize: 9, color: theme.dim }}>Total</div>
             <div style={{ fontSize: 18, fontWeight: 800, color: "#f8fafc" }}>{total}</div>
            </div>
           )}
          </div>
          <div style={{ display: isMobile ? "flex" : "contents", gap: 8 }}>
           <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
             <label style={{ fontSize: 10, color: theme.dim }}>Base</label>
             <LockBtn locked={isLocked(bKey)} onToggle={function () { toggleLock(bKey); }} size={9} />
            </div>
            <input type="number" value={baseVal}
             onChange={function (e) { setEditVal(editCat, entry.owner, "base", e.target.value); }}
             style={{ ...inputStyle, padding: "6px 8px", fontSize: 13 }} />
           </div>
           <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
             <label style={{ fontSize: 10, color: theme.dim }}>Bonus</label>
             <LockBtn locked={isLocked(bnKey)} onToggle={function () { toggleLock(bnKey); }} size={9} />
            </div>
            <input type="number" value={bonusVal}
             onChange={function (e) { setEditVal(editCat, entry.owner, "bonus", e.target.value); }}
             style={{ ...inputStyle, padding: "6px 8px", fontSize: 13 }} />
           </div>
          </div>
          {!isMobile && (
           <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 9, color: theme.dim }}>Total</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#f8fafc" }}>{total}</div>
           </div>
          )}
         </div>
         <div style={{ marginTop: 8 }}>
          <label style={{ fontSize: 10, color: theme.dim, marginBottom: 2, display: "block" }}>
           Bonus Note <span style={{ color: "#64748b" }}>{"\u2014"} visible to all players in scoreboard</span>
          </label>
          <input value={getBonusNote(editCat, entry.owner)}
           onChange={function (e) { setBonusNoteVal(editCat, entry.owner, e.target.value); }}
           placeholder="e.g. +10 Won Super Bowl, +2 Wild Card bye"
           style={{ ...inputStyle, padding: "5px 8px", fontSize: 11 }} />
         </div>
        </div>
       );
      })}
     </div>
     <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
      <button onClick={applyChanges} style={{ ...buttonStyle(theme.grn), flex: 2, padding: 14, fontSize: 15 }}>
       Save Changes
      </button>
      <button onClick={function () { setEdits({}); setBonusNotes({}); setSaved(false); }}
       style={{ ...buttonStyle(theme.srf), flex: 1, border: "1px solid " + theme.bdr }}>Reset</button>
     </div>
     {saved && (
      <div style={{ marginTop: 8, padding: 8, borderRadius: 8,
       background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)",
       textAlign: "center", fontSize: 12, color: theme.grn }}>
       Changes saved and synced to scoreboard.
      </div>
     )}
    </div>
   )}

   {/* ═══ DETAIL LINES MODE ═══ */}
   {mode === "details" && (
    <div style={cardStyle}>
     <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>{CATEGORY_LABELS[editCat]} {"\u2014"} Detail Lines</h3>
     <p style={{ color: theme.dim, fontSize: 11, margin: "0 0 16px" }}>
      Add, edit, or delete individual rows (films, playoff rounds, songs, etc.). Click a member to expand.
      {(FILM_CATS.includes(editCat) || MUSIC_CATS.includes(editCat) || STOCK_CATS.includes(editCat)) && (
       <span style={{ color: "#3b82f6" }}> Base rankings auto-recalculate when you save.</span>
      )}
     </p>
     <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {catEntries.map(function (entry) {
       var mid = (members.find(function (x) { return x.name === entry.owner; }) || {}).id;
       var isExp = expandedMember === entry.owner;
       return (
        <div key={entry.owner} style={{
         borderRadius: 8, border: "1px solid " + (isExp ? theme.acc : theme.bdr),
         background: isExp ? "rgba(59,130,246,0.05)" : "rgba(51,65,85,0.2)",
         overflow: "hidden",
        }}>
         <div onClick={function () { setExpandedMember(isExp ? null : entry.owner); }}
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
           padding: "10px 14px", cursor: "pointer" }}>
          <div>
           <span style={{ fontWeight: 700, fontSize: 13, color: MEMBER_COLORS[mid] || theme.txt }}>
            {entry.owner}
           </span>
           <span style={{ fontSize: 11, color: theme.dim, marginLeft: 8 }}>{entry.pick}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
           <span style={{ fontSize: 11, color: theme.dim }}>
            {(function () {
             var d = (detail[editCat] || []).find(function (x) { return x.owner === entry.owner; });
             if (!d) return "\u2014";
             if (ct === "sport") return (d.rounds || []).length + " rounds";
             if (ct === "film") return (d.films || []).length + " films";
             if (ct === "music") return (d.songs || []).length + " songs, " + (d.grammys || []).length + " grammys";
             if (ct === "event") return (d.majors || []).length + " events";
             return "\u2014";
            })()}
           </span>
           <span style={{ fontSize: 14, color: theme.dim }}>{isExp ? "\u25B2" : "\u25BC"}</span>
          </div>
         </div>
         {isExp && (
          <div style={{ padding: "0 14px 12px", borderTop: "1px solid " + theme.bdr }}>
           {renderDetailEditor(entry)}
          </div>
         )}
        </div>
       );
      })}
     </div>
     <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
      <button onClick={applyChanges} style={{ ...buttonStyle(theme.grn), flex: 2, padding: 14, fontSize: 15 }}>
       Save All Detail Edits
      </button>
      <button onClick={function () { setDetailEdits({}); setSaved(false); }}
       style={{ ...buttonStyle(theme.srf), flex: 1, border: "1px solid " + theme.bdr }}>Reset</button>
     </div>
     {saved && (
      <div style={{ marginTop: 8, padding: 8, borderRadius: 8,
       background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)",
       textAlign: "center", fontSize: 12, color: theme.grn }}>
       Detail edits saved.{(FILM_CATS.includes(editCat) || MUSIC_CATS.includes(editCat) || STOCK_CATS.includes(editCat)) ? " Base rankings recalculated." : ""}
      </div>
     )}
    </div>
   )}

   {/* ═══ PICK SWAPS MODE ═══ */}
   {mode === "swaps" && (
    <div style={cardStyle}>
     <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>{CATEGORY_LABELS[editCat]} {"\u2014"} Swap Picks</h3>
     <p style={{ color: theme.dim, fontSize: 11, margin: "0 0 16px" }}>
      Change a member's selection mid-season.
     </p>
     <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {catEntries.map(function (entry) {
       var mid = (members.find(function (x) { return x.name === entry.owner; }) || {}).id;
       var swapVal = getSwapVal(editCat, entry.owner);
       var changed = swaps[editCat + "|" + entry.owner] !== undefined
        && swaps[editCat + "|" + entry.owner] !== entry.pick;
       return (
        <div key={entry.owner} style={{
         display: "grid",
         gridTemplateColumns: isMobile ? "1fr" : "100px 1fr",
         gap: isMobile ? 4 : 12, alignItems: isMobile ? "stretch" : "center",
         padding: "10px 12px", borderRadius: 8,
         background: changed ? "rgba(59,130,246,0.08)" : "rgba(51,65,85,0.2)",
         border: "1px solid " + (changed ? theme.acc : theme.bdr),
        }}>
         <div style={{ fontWeight: 700, fontSize: 13, color: MEMBER_COLORS[mid] || theme.txt }}>
          {entry.owner}
         </div>
         <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: isMobile ? "wrap" : "nowrap" }}>
          <input value={swapVal}
           onChange={function (e) { setSwapVal(editCat, entry.owner, e.target.value); }}
           style={{ ...inputStyle, padding: "6px 8px", fontSize: 13, flex: 1 }}
           placeholder="Enter new pick..." />
          {changed && <span style={{ fontSize: 10, color: theme.acc, whiteSpace: "nowrap" }}>{"\u2190"} was: {entry.pick}</span>}
         </div>
        </div>
       );
      })}
     </div>
     <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
      <button onClick={applyChanges} style={{ ...buttonStyle(theme.grn), flex: 2, padding: 14, fontSize: 15 }}>
       Save Swaps
      </button>
      <button onClick={function () { setSwaps({}); setSaved(false); }}
       style={{ ...buttonStyle(theme.srf), flex: 1, border: "1px solid " + theme.bdr }}>Reset</button>
     </div>
     {saved && (
      <div style={{ marginTop: 8, padding: 8, borderRadius: 8,
       background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)",
       textAlign: "center", fontSize: 12, color: theme.grn }}>
       Pick swaps saved.
      </div>
     )}
    </div>
   )}

   {/* ═══ LOCKS OVERVIEW MODE ═══ */}
   {mode === "locks" && (
    <div style={cardStyle}>
     <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>{"\uD83D\uDD12"} Lock Manager {"\u2014"} {CATEGORY_LABELS[editCat]}</h3>
     <p style={{ color: theme.dim, fontSize: 11, margin: "0 0 12px" }}>
      Locked fields won't be overwritten by cron jobs. Other players see a lock icon with a hover tooltip.
      New seasons always start with zero locks.
     </p>
     {(function () {
      var catLocks = Object.entries(locks).filter(function (pair) { return pair[0].startsWith(editCat + "|"); });
      if (catLocks.length === 0) {
       return <p style={{ color: theme.dim, fontSize: 12, textAlign: "center", padding: 20 }}>
        No locks in {CATEGORY_LABELS[editCat]}. Use the Scores or Details tabs to lock fields.
       </p>;
      }
      return (
       <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {catLocks.map(function (pair) {
         var key = pair[0];
         var info = pair[1];
         var parts = key.split("|");
         var owner = parts[1];
         var field = parts.slice(2).join(" \u2192 ");
         var mid = (members.find(function (x) { return x.name === owner; }) || {}).id;
         return (
          <div key={key} style={{
           display: "flex", justifyContent: "space-between", alignItems: "center",
           padding: "8px 12px", borderRadius: 8,
           background: "rgba(234,179,8,0.06)", border: "1px solid rgba(234,179,8,0.2)",
          }}>
           <div>
            <span style={{ fontWeight: 700, fontSize: 12, color: MEMBER_COLORS[mid] || theme.txt }}>
             {owner}
            </span>
            <span style={{ fontSize: 11, color: theme.dim, marginLeft: 8 }}>{field}</span>
            {info.at && (
             <span style={{ fontSize: 9, color: "#64748b", marginLeft: 8 }}>
              {new Date(info.at).toLocaleDateString()}
             </span>
            )}
           </div>
           <button onClick={function () { toggleLock(key); }}
            style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)",
             borderRadius: 4, padding: "4px 8px", fontSize: 10, color: "#ef4444",
             cursor: "pointer", fontWeight: 600 }}>
            Unlock
           </button>
          </div>
         );
        })}
       </div>
      );
     })()}
     <div style={{ marginTop: 16, padding: 10, borderRadius: 8,
      background: "rgba(234,179,8,0.06)", border: "1px solid rgba(234,179,8,0.2)" }}>
      <div style={{ fontSize: 11, color: "#eab308" }}>
       <b>How locks work:</b> Your cron job checks the locks column in Supabase before overwriting any data.
       If a field is locked, the cron skips it and logs what it skipped.
      </div>
     </div>
    </div>
   )}

   {/* ═══ CHANGE LOG ═══ */}
   {mode === "log" && (
    <div style={cardStyle}>
     <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>Change Log</h3>
     {changelog.length === 0 ? (
      <p style={{ color: theme.dim, fontSize: 13 }}>No changes recorded this session.</p>
     ) : (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
       {changelog.map(function (entry, i) {
        return (
         <div key={i} style={{ padding: "8px 12px", borderRadius: 8,
          background: "rgba(51,65,85,0.3)", border: "1px solid " + theme.bdr,
          fontSize: 12, color: theme.txt, wordBreak: "break-word" }}>
          <span style={{ color: theme.dim, marginRight: 8 }}>#{changelog.length - i}</span>
          {entry}
         </div>
        );
       })}
      </div>
     )}
    </div>
   )}
  </div>
 );
}
