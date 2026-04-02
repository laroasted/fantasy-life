import { useState, useMemo, useEffect, useRef } from "react";
import { supabase } from "../utils/storage";
import { theme } from "../constants/theme";
 
// ══════════════════════════════════════════════════════
//  FANTASY LIFE CALENDAR
//  Fetches from Supabase calendar_events table
//  Falls back to hardcoded FALLBACK_EVENTS if fetch fails
//  Renders as a tab inside the Hub shell
// ══════════════════════════════════════════════════════
 
const s = theme;
 
const CAT = {
  NFL:{icon:"🏈",color:"#22c55e"}, MLB:{icon:"⚾",color:"#ef4444"}, NBA:{icon:"🏀",color:"#f97316"},
  NHL:{icon:"🏒",color:"#06b6d4"}, NCAAF:{icon:"🏟️",color:"#eab308"}, NCAAB:{icon:"🎓",color:"#eab308"},
  MLS:{icon:"⚽",color:"#14b8a6"}, Tennis:{icon:"🎾",color:"#a3e635"}, Golf:{icon:"⛳",color:"#34d399"},
  F1:{icon:"🏎️",color:"#ef4444"}, Actor:{icon:"🎬",color:"#8b5cf6"}, Actress:{icon:"💫",color:"#d946ef"},
  Musician:{icon:"🎵",color:"#ec4899"}, Country:{icon:"🌍",color:"#3b82f6"}, Stock:{icon:"📈",color:"#10b981"},
  General:{icon:"⭐",color:"#fbbf24"}, Film:{icon:"🎬",color:"#c084fc"},
};
 
// ── Fallback events (used if Supabase fetch fails) ──
const FALLBACK_EVENTS = [
  { date:"2026-03-15", title:"Fantasy Life 2026 Draft", subtitle:"Annual draft day", category:"General", type:"draft" },
  { date:"2026-03-15", title:"98th Academy Awards (Oscars)", subtitle:"Dolby Theatre, Hollywood — Actor/Actress bonus pts", category:"Film", type:"awards_show", bonus:true, result:"Best Actor: Michael B. Jordan · Best Actress: Jessie Buckley" },
  { date:"2026-03-15", title:"NCAA Tournament — March Madness", subtitle:"First & Second Rounds begin", category:"NCAAB", type:"playoffs_start", bonus:true },
  { date:"2026-03-15", title:"Project Hail Mary", subtitle:"Ryan Gosling (Danny · Actor) & Meryl Streep (Auzy · Actress)", category:"Film", type:"film_release" },
  { date:"2026-03-18", title:"Free Spirits", subtitle:"Jack Black (Jordan · Actor)", category:"Film", type:"film_release" },
  { date:"2026-03-22", title:"MLS Season Opens", subtitle:"2026 MLS regular season kicks off", category:"MLS", type:"season_start" },
  { date:"2026-03-25", title:"MLB Opening Day", subtitle:"NYY @ SF Giants (Opening Night) · Full slate Mar 26", category:"MLB", type:"season_start" },
  { date:"2026-03-26", title:"The Magic Faraway Tree", subtitle:"Rebecca Ferguson (Jordan · Actress)", category:"Film", type:"film_release" },
  { date:"2026-04-01", title:"The Super Mario Galaxy Movie", subtitle:"Jack Black (Jordan · Actor) & Anya Taylor-Joy (Marsh · Actress)", category:"Film", type:"film_release" },
  { date:"2026-04-01", title:"The Drama", subtitle:"Robert Pattinson (Scott · Actor) & Zendaya (Evan · Actress)", category:"Film", type:"film_release" },
  { date:"2026-04-04", title:"NCAA Championship — Final Four", subtitle:"National Semifinals & Championship", category:"NCAAB", type:"championship", bonus:true },
  { date:"2026-04-09", title:"The Masters", subtitle:"Augusta National Golf Club, Augusta, GA", category:"Golf", type:"major", bonus:true },
  { date:"2026-04-15", title:"NHL Playoffs Begin", subtitle:"Stanley Cup Playoffs first round", category:"NHL", type:"playoffs_start", bonus:true },
  { date:"2026-04-17", title:"Mother Mary", subtitle:"Anne Hathaway (Mike · Actress)", category:"Film", type:"film_release" },
  { date:"2026-04-18", title:"NBA Playoffs Begin", subtitle:"First round tips off", category:"NBA", type:"playoffs_start", bonus:true },
  { date:"2026-04-23", title:"NFL Draft", subtitle:"Acrisure Stadium, Pittsburgh, PA", category:"NFL", type:"other" },
  { date:"2026-04-29", title:"The Devil Wears Prada 2", subtitle:"Meryl Streep (Auzy), Anne Hathaway (Mike) & Emily Blunt (Scott · Actresses)", category:"Film", type:"film_release" },
  { date:"2026-05-03", title:"F1 Miami Grand Prix", subtitle:"Miami International Autodrome, FL", category:"F1", type:"major", bonus:true },
  { date:"2026-05-12", title:"The Punisher: One Last Kill", subtitle:"Jon Bernthal (Marsh · Actor)", category:"Film", type:"film_release" },
  { date:"2026-05-14", title:"PGA Championship", subtitle:"Aronimink Golf Club, Newtown Square, PA", category:"Golf", type:"major", bonus:true },
  { date:"2026-05-20", title:"The Mandalorian & Grogu", subtitle:"Pedro Pascal (Mike · Actor)", category:"Film", type:"film_release" },
  { date:"2026-05-24", title:"French Open (Roland Garros)", subtitle:"Stade Roland-Garros, Paris, France", category:"Tennis", type:"major", bonus:true },
  { date:"2026-06-08", title:"Stanley Cup Finals", subtitle:"NHL Championship series begins", category:"NHL", type:"championship", bonus:true },
  { date:"2026-06-10", title:"Disclosure Day", subtitle:"Emily Blunt (Scott · Actress)", category:"Film", type:"film_release" },
  { date:"2026-06-11", title:"FIFA World Cup 2026 Begins", subtitle:"United States, Mexico & Canada", category:"Country", type:"other" },
  { date:"2026-06-15", title:"NBA Finals Begin", subtitle:"Championship series tips off", category:"NBA", type:"championship", bonus:true },
  { date:"2026-06-18", title:"US Open (Golf)", subtitle:"Shinnecock Hills Golf Club, Southampton, NY", category:"Golf", type:"major", bonus:true },
  { date:"2026-06-24", title:"Supergirl", subtitle:"Jason Momoa (Jack · Actor)", category:"Film", type:"film_release" },
  { date:"2026-06-29", title:"Wimbledon", subtitle:"All England Club, London, England", category:"Tennis", type:"major", bonus:true },
  { date:"2026-07-14", title:"MLB All-Star Game", subtitle:"Midsummer Classic", category:"MLB", type:"other" },
  { date:"2026-07-15", title:"The Odyssey", subtitle:"Matt Damon (Dhruv), Tom Holland (Evan), Jon Bernthal (Marsh), Robert Pattinson (Scott) & Zendaya (Evan), Anne Hathaway (Mike)", category:"Film", type:"film_release" },
  { date:"2026-07-16", title:"The Open Championship", subtitle:"Royal Birkdale Golf Club, Southport, England", category:"Golf", type:"major", bonus:true },
  { date:"2026-07-19", title:"FIFA World Cup Final", subtitle:"MetLife Stadium, East Rutherford, NJ", category:"Country", type:"championship" },
  { date:"2026-07-29", title:"Spider-Man: Brand New Day", subtitle:"Tom Holland (Evan · Actor), Jon Bernthal (Marsh · Actor) & Zendaya (Evan · Actress)", category:"Film", type:"film_release" },
  { date:"2026-08-12", title:"The End of Oak Street", subtitle:"Anne Hathaway (Mike · Actress)", category:"Film", type:"film_release" },
  { date:"2026-08-20", title:"Sacrifice", subtitle:"Anya Taylor-Joy (Marsh · Actress)", category:"Film", type:"film_release" },
  { date:"2026-08-27", title:"Tour Championship", subtitle:"East Lake Golf Club, Atlanta, GA — Golf ranking freezes", category:"Golf", type:"other" },
  { date:"2026-08-29", title:"College Football Season Opens", subtitle:"2026 NCAAF regular season begins", category:"NCAAF", type:"season_start" },
  { date:"2026-08-31", title:"US Open (Tennis)", subtitle:"Billie Jean King National Tennis Center, New York", category:"Tennis", type:"major", bonus:true },
  { date:"2026-09-09", title:"NFL Season Begins", subtitle:"2026 NFL regular season kicks off", category:"NFL", type:"season_start" },
  { date:"2026-09-10", title:"Fast Forever", subtitle:"Jason Momoa (Jack · Actor)", category:"Film", type:"film_release" },
  { date:"2026-09-22", title:"Ryder Cup", subtitle:"Medinah Country Club, Medinah, IL", category:"Golf", type:"other" },
  { date:"2026-09-28", title:"MLB Regular Season Ends", subtitle:"Final day of 2026 MLB regular season", category:"MLB", type:"season_end" },
  { date:"2026-09-30", title:"Verity", subtitle:"Anne Hathaway (Mike · Actress)", category:"Film", type:"film_release" },
  { date:"2026-10-01", title:"MLB Playoffs Begin", subtitle:"Wild Card Series starts", category:"MLB", type:"playoffs_start", bonus:true },
  { date:"2026-10-14", title:"Street Fighter", subtitle:"Jason Momoa (Jack · Actor)", category:"Film", type:"film_release" },
  { date:"2026-10-15", title:"NHL Season Opens", subtitle:"2026-27 NHL regular season begins", category:"NHL", type:"season_start" },
  { date:"2026-10-20", title:"MLB World Series", subtitle:"Fall Classic begins", category:"MLB", type:"championship", bonus:true },
  { date:"2026-10-24", title:"MLS Playoffs Begin", subtitle:"MLS Cup Playoffs first round", category:"MLS", type:"playoffs_start", bonus:true },
  { date:"2026-10-25", title:"F1 US Grand Prix (Austin)", subtitle:"Circuit of the Americas, Austin, TX", category:"F1", type:"major", bonus:true },
  { date:"2026-10-30", title:"NBA Season Opens", subtitle:"2026-27 NBA regular season tips off", category:"NBA", type:"season_start" },
  { date:"2026-11-14", title:"MLS Cup Final", subtitle:"MLS Championship Final", category:"MLS", type:"championship", bonus:true },
  { date:"2026-11-18", title:"The Hunger Games: Sunrise on the Reaping", subtitle:"Jennifer Lawrence (Dhruv · Actress)", category:"Film", type:"film_release" },
  { date:"2026-11-21", title:"F1 Las Vegas Grand Prix", subtitle:"Las Vegas Strip Circuit, Paradise, NV", category:"F1", type:"major", bonus:true },
  { date:"2026-11-26", title:"Narnia", subtitle:"Meryl Streep (Auzy · Actress)", category:"Film", type:"film_release" },
  { date:"2026-12-06", title:"F1 Season Finale — Abu Dhabi GP", subtitle:"Yas Marina Circuit — F1 driver ranking freezes", category:"F1", type:"other" },
  { date:"2026-12-16", title:"Avengers: Doomsday", subtitle:"Simu Liu (Adam), RDJ (Auzy), Chris Hemsworth (LaRosa), Pedro Pascal (Mike) & Mabel Cadena (Adam), Florence Pugh (Jack), Vanessa Kirby (LaRosa)", category:"Film", type:"film_release" },
  { date:"2026-12-16", title:"Dune: Part Three", subtitle:"Timothée Chalamet (Alan), Jason Momoa (Jack), Robert Pattinson (Scott) & Rebecca Ferguson (Jordan), Zendaya (Evan), Anya Taylor-Joy (Marsh), Florence Pugh (Jack)", category:"Film", type:"film_release" },
  { date:"2026-12-19", title:"College Football Playoff — First Round", subtitle:"CFP 12-team bracket begins", category:"NCAAF", type:"playoffs_start", bonus:true },
  { date:"2026-12-23", title:"Jumanji 3", subtitle:"Jack Black (Jordan · Actor)", category:"Film", type:"film_release" },
  { date:"2026-12-31", title:"Stock Market Year-End Close", subtitle:"Final 2026 trading day · stock price baseline", category:"Stock", type:"other" },
  { date:"2027-01-01", title:"CFP Semifinal / NY6 Bowl Games", subtitle:"College Football Playoff Semifinals", category:"NCAAF", type:"championship", bonus:true },
  { date:"2027-01-10", title:"NFL Regular Season Ends", subtitle:"Week 18 — final regular season games", category:"NFL", type:"season_end" },
  { date:"2027-01-12", title:"Australian Open", subtitle:"Melbourne Park, Melbourne, Australia", category:"Tennis", type:"major", bonus:true },
  { date:"2027-01-16", title:"NFL Playoffs — Wild Card", subtitle:"Wild Card Weekend begins", category:"NFL", type:"playoffs_start", bonus:true },
  { date:"2027-01-19", title:"CFP National Championship", subtitle:"College Football National Championship Game", category:"NCAAF", type:"championship", bonus:true },
  { date:"2027-01-22", title:"Animal Friends", subtitle:"Jason Momoa (Jack · Actor)", category:"Film", type:"film_release" },
  { date:"2027-01-23", title:"NFL Divisional Round", subtitle:"Divisional Playoff games", category:"NFL", type:"playoffs_start", bonus:true },
  { date:"2027-01-31", title:"NFL Conference Championships", subtitle:"AFC & NFC Championship Games", category:"NFL", type:"championship", bonus:true },
  { date:"2027-02-01", title:"Australian Open Final", subtitle:"Tennis world ranking baseline freezes", category:"Tennis", type:"major", bonus:true },
  { date:"2027-02-14", title:"Super Bowl LXI", subtitle:"SoFi Stadium, Inglewood, CA", category:"NFL", type:"championship", bonus:true },
  { date:"2027-02-15", title:"NBA All-Star Weekend", subtitle:"Midseason showcase", category:"NBA", type:"other" },
  { date:"2027-03-15", title:"NCAA Tournament 2027", subtitle:"March Madness — First & Second Rounds", category:"NCAAB", type:"playoffs_start", bonus:true },
  { date:"2027-03-31", title:"Fantasy Life 2026 Season Ends", subtitle:"Final day of the 2026 Fantasy Year", category:"General", type:"other" },
];
 
// ── Map Supabase row → component event shape ──
function mapDbRow(row) {
  return {
    date: row.event_date,
    title: row.title,
    subtitle: row.subtitle || "",
    category: row.category,
    type: row.event_type,
    result: row.result || null,
    bonus: row.is_bonus_eligible || false,
  };
}
 
// ── Helpers ──
function pD(str) { const [y,m,d] = str.split("-").map(Number); return new Date(y, m-1, d); }
function fmtD(str) { return pD(str).toLocaleDateString("en-US", { month:"short", day:"numeric" }); }
function status(dateStr) {
  const ev = pD(dateStr), now = new Date();
  ev.setHours(0,0,0,0); now.setHours(0,0,0,0);
  const diff = Math.floor((ev - now) / 864e5);
  return diff < 0 ? "past" : diff <= 7 ? "now" : "future";
}
function monthKey(dateStr) {
  return pD(dateStr).toLocaleDateString("en-US", { month:"long", year:"numeric" }).toUpperCase();
}
 
const FILTERS = [
  { id:"all", label:"All" }, { id:"bonus", label:"★ Bonus" }, { id:"sport", label:"🏈 Sports" },
  { id:"event", label:"🎾 Tennis/Golf/F1" }, { id:"ent", label:"🎬 Film & Music" },
];
function pass(ev, f) {
  if (f === "all") return true;
  if (f === "bonus") return ev.bonus;
  if (f === "sport") return ["NFL","MLB","NBA","NHL","NCAAF","NCAAB","MLS"].includes(ev.category);
  if (f === "event") return ["Tennis","Golf","F1"].includes(ev.category);
  if (f === "ent") return ["Actor","Actress","Musician","Film"].includes(ev.category);
  return true;
}
function typeBadge(t) {
  const m = {
    championship:{l:"CHAMPIONSHIP",b:"rgba(239,68,68,0.12)",c:"#f87171"},
    major:{l:"MAJOR",b:"rgba(34,197,94,0.12)",c:"#4ade80"},
    playoffs_start:{l:"PLAYOFFS",b:"rgba(249,115,22,0.12)",c:"#fb923c"},
    season_start:{l:"SEASON",b:"rgba(59,130,246,0.12)",c:"#60a5fa"},
    season_end:{l:"SEASON END",b:"rgba(100,116,139,0.12)",c:"#94a3b8"},
    awards_show:{l:"AWARDS",b:"rgba(234,179,8,0.12)",c:"#fbbf24"},
    draft:{l:"FL EVENT",b:"rgba(251,191,36,0.12)",c:"#fde047"},
    film_release:{l:"RELEASE",b:"rgba(139,92,246,0.12)",c:"#a78bfa"},
  };
  const d = m[t] || { l:"EVENT", b:"rgba(100,116,139,0.12)", c:"#94a3b8" };
  return { label:d.l, bg:d.b, color:d.c };
}
 
// ══════════════════════════════════════════════════════
export default function Calendar({ seasonYear }) {
  const [filter, setFilter] = useState("all");
  const [expId, setExpId] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState("loading");
  const activeRef = useRef(null);
  const [didScroll, setDidScroll] = useState(false);
 
  const yr = seasonYear || 2026;
 
  // ── Fetch from Supabase, fall back to hardcoded ──
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from("calendar_events")
          .select("*")
          .eq("season_year", yr)
          .order("event_date")
          .order("sort_order");
        if (!cancelled && data && data.length > 0 && !error) {
          setEvents(data.map(mapDbRow));
          setSource("supabase");
        } else {
          if (!cancelled) {
            console.warn("Calendar: Supabase returned no data or error, using fallback.", error);
            setEvents(FALLBACK_EVENTS);
            setSource("fallback");
          }
        }
      } catch (e) {
        if (!cancelled) {
          console.error("Calendar: fetch failed, using fallback.", e);
          setEvents(FALLBACK_EVENTS);
          setSource("fallback");
        }
      }
      if (!cancelled) setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [yr]);
 
  const sorted = useMemo(() =>
    [...events].filter(e => pass(e, filter)).sort((a,b) => a.date.localeCompare(b.date)),
  [events, filter]);
 
  const grouped = useMemo(() => {
    const m = new Map();
    sorted.forEach(e => { const k = monthKey(e.date); if (!m.has(k)) m.set(k, []); m.get(k).push(e); });
    return m;
  }, [sorted]);
 
  const firstActiveIdx = useMemo(() => {
    for (let i = 0; i < sorted.length; i++) if (status(sorted[i].date) !== "past") return i;
    return -1;
  }, [sorted]);
 
  // Reset scroll when filter changes
  useEffect(() => { setDidScroll(false); }, [filter]);
 
  // Auto-scroll to "this week" / first upcoming
  useEffect(() => {
    if (!didScroll && !loading && activeRef.current) {
      const t = setTimeout(() => {
        activeRef.current?.scrollIntoView({ behavior:"smooth", block:"center" });
        setDidScroll(true);
      }, 150);
      return () => clearTimeout(t);
    }
  }, [didScroll, grouped, loading]);
 
  if (loading) {
    return (
      <div style={{ maxWidth:760, margin:"0 auto", textAlign:"center", padding:60, color:s.dim }}>
        <div style={{ fontSize:24, marginBottom:8 }}>📅</div>
        <div style={{ fontSize:14, fontWeight:600 }}>Loading calendar...</div>
      </div>
    );
  }
 
  return (
    <div style={{ maxWidth:760, margin:"0 auto" }}>
      {/* Filter pills */}
      <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:16, justifyContent:"center" }}>
        {FILTERS.map(f => {
          const on = filter === f.id;
          return (
            <button key={f.id} onClick={() => setFilter(f.id)}
              style={{ padding:"5px 10px", borderRadius:20,
                border:"1px solid " + (on ? s.acc : "#334155"),
                background: on ? s.acc : "#1e293b",
                color:"#f1f5f9", fontSize:11, fontWeight: on ? 700 : 500,
                cursor:"pointer", whiteSpace:"nowrap" }}>
              {f.label}
            </button>
          );
        })}
        <span style={{ fontSize:9, color:s.dim, alignSelf:"center", marginLeft:4 }}>
          {source === "supabase" ? "🟢 Live" : "🟡 Cached"}
        </span>
      </div>
 
      {/* Event list grouped by month */}
      {[...grouped.entries()].map(([month, evts]) => {
        const allDone = evts.every(e => status(e.date) === "past");
        return (
          <div key={month}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline",
              borderBottom:"2px solid " + (allDone ? "#334155" : s.acc),
              paddingBottom:5, marginTop:20, marginBottom:6 }}>
              <span style={{ fontSize:13, fontWeight:800, letterSpacing:2,
                color: allDone ? "#475569" : "#f8fafc" }}>{month}</span>
              <span style={{ fontSize:10, color:"#64748b" }}>
                {evts.length} event{evts.length !== 1 ? "s" : ""}
              </span>
            </div>
 
            {evts.map((ev, idx) => {
              const st = status(ev.date);
              const cat = CAT[ev.category] || CAT.General;
              const tb = typeBadge(ev.type);
              const isPast = st === "past", isNow = st === "now";
              const gIdx = sorted.indexOf(ev);
              const isFirst = gIdx === firstActiveIdx;
              const eid = ev.date + "-" + idx;
              const isExp = expId === eid;
 
              return (
                <div key={eid} ref={isFirst ? activeRef : null}
                  onClick={() => setExpId(isExp ? null : eid)}
                  style={{
                    display:"grid", gridTemplateColumns:"52px 36px 1fr", gap:8, alignItems:"start",
                    padding:"10px 8px", margin:"1px 0", borderRadius:10, cursor:"pointer",
                    background: isNow ? "rgba(59,130,246,0.06)" : isExp ? "rgba(30,41,59,0.4)" : "transparent",
                    borderLeft: isNow ? "3px solid " + s.grn
                      : isFirst && !isNow ? "3px solid " + s.acc : "3px solid transparent",
                    opacity: isPast ? 0.4 : 1, transition:"all 0.15s",
                  }}
                  onMouseEnter={e => { if (!isPast) e.currentTarget.style.background = "rgba(30,41,59,0.5)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = isNow ? "rgba(59,130,246,0.06)" : "transparent"; }}
                >
                  {/* Date */}
                  <div style={{ textAlign:"right", paddingTop:1 }}>
                    <div style={{ fontSize:10, fontWeight:600, color: isPast ? "#475569" : isNow ? s.grn : s.dim, lineHeight:1.3 }}>
                      {fmtD(ev.date).split(" ")[0]}
                    </div>
                    <div style={{ fontSize:17, fontWeight:800, color: isPast ? "#475569" : isNow ? s.grn : "#f8fafc", lineHeight:1.2 }}>
                      {fmtD(ev.date).split(" ")[1]}
                    </div>
                  </div>
 
                  {/* Icon */}
                  <div style={{
                    width:32, height:32, borderRadius:8,
                    background: isPast ? "#1e293b" : cat.color + "15",
                    border:"1px solid " + (isPast ? "#334155" : cat.color + "33"),
                    display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, marginTop:2,
                  }}>{cat.icon}</div>
 
                  {/* Content */}
                  <div style={{ minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"flex-start", gap:5, flexWrap:"wrap" }}>
                      <span style={{ fontSize:13, fontWeight:700, lineHeight:1.3, flex:1,
                        color: isPast ? "#64748b" : isNow ? "#f8fafc" : "#e2e8f0" }}>{ev.title}</span>
                      <div style={{ display:"flex", gap:3, flexShrink:0, marginTop:1 }}>
                        {ev.bonus && <span style={{ fontSize:8, fontWeight:700, padding:"2px 4px", borderRadius:3,
                          background: isPast ? "#1e293b" : "rgba(234,179,8,0.12)",
                          color: isPast ? "#475569" : s.yel,
                          border:"1px solid " + (isPast ? "#334155" : "rgba(234,179,8,0.2)") }}>★ BONUS</span>}
                        <span style={{ fontSize:8, fontWeight:700, padding:"2px 4px", borderRadius:3,
                          background: isPast ? "#1e293b" : tb.bg,
                          color: isPast ? "#64748b" : tb.color,
                          border:"1px solid " + (isPast ? "#334155" : tb.color + "33") }}>{tb.label}</span>
                      </div>
                    </div>
                    <div style={{ fontSize:11, color: isPast ? "#475569" : "#94a3b8", marginTop:2, lineHeight:1.4 }}>{ev.subtitle}</div>
                    {isPast && ev.result && <div style={{ marginTop:4, fontSize:10, fontWeight:600, color:s.grn, opacity:0.8,
                      padding:"2px 6px", background:"rgba(34,197,94,0.08)", borderRadius:4, display:"inline-block" }}>{ev.result}</div>}
                    <div style={{ marginTop:4, display:"flex", gap:5, alignItems:"center" }}>
                      <span style={{ fontSize:9, fontWeight:600, padding:"1px 6px", borderRadius:10,
                        background: isPast ? "#1e293b" : cat.color + "12",
                        color: isPast ? "#475569" : cat.color }}>{ev.category}</span>
                      {isNow && <span style={{ fontSize:9, fontWeight:700, color:s.grn, display:"flex", alignItems:"center", gap:3 }}>
                        <span style={{ width:5, height:5, borderRadius:"50%", background:s.grn, display:"inline-block", animation:"calPulse 2s infinite" }}/>THIS WEEK
                      </span>}
                    </div>
                    {isExp && <div style={{ marginTop:8, padding:"10px", borderRadius:10,
                      background:s.card, border:"1px solid " + s.bdr, fontSize:11, color:s.mut, lineHeight:1.6 }}>
                      <div style={{ display:"grid", gridTemplateColumns:"auto 1fr", gap:"3px 12px" }}>
                        <span style={{ color:s.dim, fontWeight:600 }}>Date</span>
                        <span>{pD(ev.date).toLocaleDateString("en-US",{ weekday:"long", month:"long", day:"numeric", year:"numeric" })}</span>
                        <span style={{ color:s.dim, fontWeight:600 }}>Category</span>
                        <span style={{ color:cat.color }}>{cat.icon} {ev.category}</span>
                        <span style={{ color:s.dim, fontWeight:600 }}>Type</span>
                        <span style={{ color:tb.color }}>{tb.label}</span>
                        {ev.bonus && <><span style={{ color:s.dim, fontWeight:600 }}>Bonus</span>
                          <span style={{ color:s.yel }}>★ Eligible for Fantasy Life bonus points</span></>}
                        <span style={{ color:s.dim, fontWeight:600 }}>Status</span>
                        <span style={{ fontWeight:700, color: isPast ? s.dim : isNow ? s.grn : s.acc }}>
                          {isPast ? "Completed" : isNow ? "Happening Now / This Week" : "Upcoming"}</span>
                      </div>
                    </div>}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
 
      <div style={{ textAlign:"center", padding:"24px 16px", marginTop:12, borderTop:"1px solid #334155", color:"#475569", fontSize:11 }}>
        <div>Fantasy Life {yr} · Mar 15, {yr} → Mar 31, {yr + 1}</div>
        <div style={{ marginTop:3 }}>Questions? Contact <span style={{ color:s.grn }}>Commissioner Adam</span></div>
      </div>
 
      <style>{`@keyframes calPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}`}</style>
    </div>
  );
}
