import { useState, useEffect, useCallback } from "react";

// ─── MLB API ──────────────────────────────────────────────────────────────────
const API = "/mlb-api";

const fetchTodayGames = async () => {
  const today = new Date().toISOString().split("T")[0];
  const res = await fetch(`${API}/schedule?sportId=1&date=${today}&hydrate=team,linescore,probablePitcher,person,venue,stats`);
  if (!res.ok) throw new Error("API error");
  const data = await res.json();
  return data.dates?.[0]?.games || [];
};

const fetchStandings = async () => {
  const season = new Date().getFullYear();
  const res = await fetch(`${API}/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`);
  if (!res.ok) throw new Error("standings error");
  const data = await res.json();
  return data.records || [];
};

const fetchTeamStats = async (teamId) => {
  try {
    const season = new Date().getFullYear();
    const res = await fetch(`${API}/teams/${teamId}/stats?stats=season&group=hitting,pitching&season=${season}`);
    const data = await res.json();
    return data.stats || [];
  } catch { return []; }
};

// ─── MATH ENGINE ─────────────────────────────────────────────────────────────
const log5 = (pA, pB) => {
  const n = pA - pA * pB;
  const d = pA + pB - 2 * pA * pB;
  if (d === 0) return 0.5;
  return Math.min(0.93, Math.max(0.07, n / d));
};

const eraToRunFactor = (era) => Math.max(0.5, Math.min(1.5, (4.5 - era) / 4.5 + 1));
const opsToRunFactor = (ops) => 0.5 + (ops / 0.750) * 0.5;
const norm = (val, min, max) => Math.round(Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100)));

const toAmerican = (p) => {
  if (p <= 0 || p >= 1) return "N/A";
  if (p >= 0.5) return `-${Math.round((p / (1 - p)) * 100)}`;
  return `+${Math.round(((1 - p) / p) * 100)}`;
};

const probToDecimal = (p) => (p <= 0 ? 1 : 1 / p);

// ─── GAME ANALYSIS ────────────────────────────────────────────────────────────
const analyzeGame = (game, winPctMap, teamStatsMap) => {
  const homeId = game.teams?.home?.team?.id;
  const awayId = game.teams?.away?.team?.id;
  const homeName = game.teams?.home?.team?.teamName || game.teams?.home?.team?.name || "Local";
  const awayName = game.teams?.away?.team?.teamName || game.teams?.away?.team?.name || "Visit.";
  const homeAbbr = game.teams?.home?.team?.abbreviation || homeName.slice(0, 3).toUpperCase();
  const awayAbbr = game.teams?.away?.team?.abbreviation || awayName.slice(0, 3).toUpperCase();

  const hWp = winPctMap[homeId] || 0.500;
  const aWp = winPctMap[awayId] || 0.500;

  const homePitcherName = game.teams?.home?.probablePitcher
    ? `${game.teams.home.probablePitcher.lastName}.${(game.teams.home.probablePitcher.firstName || "")[0] || ""}`
    : "TBD";
  const awayPitcherName = game.teams?.away?.probablePitcher
    ? `${game.teams.away.probablePitcher.lastName}.${(game.teams.away.probablePitcher.firstName || "")[0] || ""}`
    : "TBD";

  const homeStats = teamStatsMap[homeId] || {};
  const awayStats = teamStatsMap[awayId] || {};

  const homeOPS = homeStats.ops || 0.730;
  const awayOPS = awayStats.ops || 0.730;
  const homeERA = homeStats.era || 4.00;
  const awayERA = awayStats.era || 4.00;
  const homeBullpenERA = homeStats.bullpenEra || 3.80;
  const awayBullpenERA = awayStats.bullpenEra || 3.80;
  const homeWhip = homeStats.whip || 1.25;
  const awayWhip = awayStats.whip || 1.25;
  const homePkFactor = homeStats.parkFactor || 100;

  const homeM1 = norm(1 / (homeERA * homeWhip), 1 / (7 * 2), 1 / (2 * 0.8));
  const awayM1 = norm(1 / (awayERA * awayWhip), 1 / (7 * 2), 1 / (2 * 0.8));
  const homeM2 = norm(hWp, 0.35, 0.70);
  const awayM2 = norm(aWp, 0.35, 0.70);
  const homeM3HasData = homeStats.era != null;
  const awayM3HasData = awayStats.era != null;
  const homeM3 = norm(opsToRunFactor(awayOPS) / eraToRunFactor(homeERA), 0.4, 1.6);
  const awayM3 = norm(opsToRunFactor(homeOPS) / eraToRunFactor(awayERA), 0.4, 1.6);
  const homeRunDiff = homeStats.runDiff || 0;
  const awayRunDiff = awayStats.runDiff || 0;
  const homeM4 = norm(homeRunDiff, -80, 80);
  const awayM4 = norm(awayRunDiff, -80, 80);

  const homeComposite = homeM1 * 0.30 + homeM2 * 0.25 + homeM3 * 0.25 + homeM4 * 0.20;
  const awayComposite = awayM1 * 0.30 + awayM2 * 0.25 + awayM3 * 0.25 + awayM4 * 0.20;

  const hAdj = Math.min(0.94, hWp * 1.04);
  const aAdj = Math.min(0.94, aWp * 0.96);
  const homeWinProb = log5(hAdj, aAdj);
  const awayWinProb = 1 - homeWinProb;

  const homeRS = 4.3 * opsToRunFactor(homeOPS) * eraToRunFactor(awayERA) * (homePkFactor / 100);
  const awayRS = 4.3 * opsToRunFactor(awayOPS) * eraToRunFactor(homeERA) * (homePkFactor / 100);

  const tendency = (m1, m2, m4) => {
    const avg = (m1 + m2 + m4) / 3;
    if (avg >= 60) return "En alza";
    if (avg <= 40) return "En baja";
    return "Sin data";
  };

  const edge = Math.abs(homeComposite - awayComposite);
  const confidence = Math.min(95, Math.round(50 + edge * 0.6));
  const favorite = homeWinProb >= 0.5 ? homeAbbr : awayAbbr;
  const favProb = homeWinProb >= 0.5 ? homeWinProb : awayWinProb;

  const gameTime = game.gameDate
    ? new Date(game.gameDate).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }) + " ET"
    : "TBD";

  return {
    gameId: game.gamePk || Math.random(),
    home: { name: homeName, abbr: homeAbbr, id: homeId },
    away: { name: awayName, abbr: awayAbbr, id: awayId },
    homePitcher: homePitcherName,
    awayPitcher: awayPitcherName,
    venue: game.venue?.name || "",
    time: gameTime,
    homeWinProb: Math.round(homeWinProb * 100),
    awayWinProb: Math.round(awayWinProb * 100),
    projHome: +homeRS.toFixed(1),
    projAway: +awayRS.toFixed(1),
    ou: +(homeRS + awayRS).toFixed(1),
    homeComposite: +homeComposite.toFixed(1),
    awayComposite: +awayComposite.toFixed(1),
    models: {
      home: { m1: homeM1, m2: homeM2, m3: homeM3HasData ? homeM3 : null, m4: homeM4, t1: tendency(homeM1, homeM2, homeM4), t2: tendency(homeM1, homeM2, homeM4), t3: homeM3HasData ? tendency(homeM3, homeM2, homeM4) : "Sin data", t4: tendency(homeM4, homeM2, homeM1), cfRecientes: +homeRS.toFixed(2), ccRecientes: +(homeRS * 0.85).toFixed(2), eraAbridor: homeERA, raBullpen: homeBullpenERA },
      away: { m1: awayM1, m2: awayM2, m3: awayM3HasData ? awayM3 : null, m4: awayM4, t1: tendency(awayM1, awayM2, awayM4), t2: tendency(awayM1, awayM2, awayM4), t3: awayM3HasData ? tendency(awayM3, awayM2, awayM4) : "Sin data", t4: tendency(awayM4, awayM2, awayM1), cfRecientes: +awayRS.toFixed(2), ccRecientes: +(awayRS * 0.85).toFixed(2), eraAbridor: awayERA, raBullpen: awayBullpenERA },
    },
    edgeNeto: +(homeComposite - awayComposite).toFixed(1),
    confidence,
    favorite,
    favProb,
    homeOdds: toAmerican(homeWinProb),
    awayOdds: toAmerican(awayWinProb),
  };
};

// ─── PARLAY BUILDER ───────────────────────────────────────────────────────────
const buildParlays = (predictions, count = 10, size = 10) => {
  if (predictions.length < 3) return [];
  const pool = [];
  predictions.forEach((g) => {
    const hProb = g.homeWinProb / 100;
    const aProb = g.awayWinProb / 100;
    const ou = g.ou;
    const overProb = hProb > 0.55 ? 0.54 : 0.48;
    pool.push({ game: `${g.away.abbr} @ ${g.home.abbr}`, pick: g.home.abbr, type: "ML", prob: hProb, odds: toAmerican(hProb), confidence: g.confidence });
    pool.push({ game: `${g.away.abbr} @ ${g.home.abbr}`, pick: g.away.abbr, type: "ML", prob: aProb, odds: toAmerican(aProb), confidence: 100 - g.confidence });
    pool.push({ game: `${g.away.abbr} @ ${g.home.abbr}`, pick: `OVER ${ou.toFixed(1)}`, type: "O/U", prob: overProb, odds: toAmerican(overProb), confidence: Math.round(overProb * 100) });
    pool.push({ game: `${g.away.abbr} @ ${g.home.abbr}`, pick: `UNDER ${ou.toFixed(1)}`, type: "O/U", prob: 1 - overProb, odds: toAmerican(1 - overProb), confidence: Math.round((1 - overProb) * 100) });
    if (hProb > 0.60) pool.push({ game: `${g.away.abbr} @ ${g.home.abbr}`, pick: `${g.home.abbr} -1.5`, type: "RL", prob: hProb * 0.72, odds: toAmerican(hProb * 0.72), confidence: Math.round(hProb * 72) });
    if (aProb > 0.60) pool.push({ game: `${g.away.abbr} @ ${g.home.abbr}`, pick: `${g.away.abbr} -1.5`, type: "RL", prob: aProb * 0.72, odds: toAmerican(aProb * 0.72), confidence: Math.round(aProb * 72) });
  });

  const strategies = [
    { name: "🔥 Alta Confianza", filter: (s) => s.confidence >= 58, sort: (a, b) => b.confidence - a.confidence },
    { name: "💎 Valor Máximo ML", filter: (s) => s.type === "ML", sort: (a, b) => b.prob - a.prob },
    { name: "🎯 Mixto Balanceado A", filter: () => true, sort: () => Math.random() - 0.5 },
    { name: "⚡ Run Lines", filter: (s) => s.type === "RL", sort: (a, b) => b.confidence - a.confidence },
    { name: "📊 Totales O/U", filter: (s) => s.type === "O/U", sort: (a, b) => b.confidence - a.confidence },
    { name: "🔥 Confianza Media", filter: (s) => s.confidence >= 52, sort: (a, b) => b.prob - a.prob },
    { name: "💎 ML + Run Lines", filter: (s) => s.type !== "O/U", sort: (a, b) => b.confidence - a.confidence },
    { name: "🎯 Mixto Balanceado B", filter: () => true, sort: () => Math.random() - 0.5 },
    { name: "⚡ Favoritos Fuertes", filter: (s) => s.prob > 0.55, sort: (a, b) => b.prob - a.prob },
    { name: "📊 Combo Completo", filter: () => true, sort: (a, b) => b.confidence - a.confidence },
  ];
  const colors = ["#e85d04","#f59e0b","#00e5a0","#4a8ab5","#a855f7","#ec4899","#06b6d4","#84cc16","#f97316","#6366f1"];

  return strategies.slice(0, count).map((strat, i) => {
    const filtered = pool.filter(strat.filter).sort(strat.sort);
    const seen = new Set();
    const picks = [];
    for (const s of filtered) {
      if (!seen.has(s.game) && picks.length < size) { seen.add(s.game); picks.push(s); }
    }
    for (const s of pool.sort(() => Math.random() - 0.5)) {
      if (!picks.find((p) => p === s) && picks.length < size) picks.push(s);
    }
    const usedPicks = picks.slice(0, Math.min(size, picks.length));
    const combinedProb = usedPicks.reduce((acc, p) => acc * p.prob, 1);
    const decimalPayout = usedPicks.reduce((acc, p) => acc * probToDecimal(p.prob), 1);
    return { id: i + 1, name: strat.name, picks: usedPicks, combinedProb: (combinedProb * 100).toFixed(3), payout: `${Math.round(decimalPayout)}x`, payoutRaw: decimalPayout, color: colors[i] };
  });
};

// ─── MOCK DATA ────────────────────────────────────────────────────────────────
const MOCK_STATS = {
  147: { ops:0.765,era:3.42,bullpenEra:3.10,whip:1.18,runDiff:45,parkFactor:103 },
  119: { ops:0.788,era:3.15,bullpenEra:2.90,whip:1.10,runDiff:62,parkFactor:96 },
  117: { ops:0.748,era:3.58,bullpenEra:3.20,whip:1.22,runDiff:38,parkFactor:98 },
  144: { ops:0.762,era:3.71,bullpenEra:3.45,whip:1.24,runDiff:41,parkFactor:100 },
  139: { ops:0.718,era:3.55,bullpenEra:3.30,whip:1.21,runDiff:22,parkFactor:95 },
  143: { ops:0.751,era:3.80,bullpenEra:3.60,whip:1.26,runDiff:28,parkFactor:101 },
  141: { ops:0.742,era:3.91,bullpenEra:3.70,whip:1.28,runDiff:18,parkFactor:99 },
  135: { ops:0.728,era:3.65,bullpenEra:3.40,whip:1.23,runDiff:20,parkFactor:92 },
  136: { ops:0.704,era:3.38,bullpenEra:3.05,whip:1.16,runDiff:30,parkFactor:94 },
  114: { ops:0.716,era:3.48,bullpenEra:3.15,whip:1.19,runDiff:25,parkFactor:97 },
  111: { ops:0.749,era:4.12,bullpenEra:3.90,whip:1.31,runDiff:12,parkFactor:104 },
  112: { ops:0.730,era:4.05,bullpenEra:3.85,whip:1.29,runDiff:8,parkFactor:101 },
};
const MOCK_WP = { 147:0.580,119:0.625,117:0.555,144:0.570,139:0.532,143:0.555,141:0.518,135:0.540,136:0.525,114:0.548,111:0.510,112:0.495 };

const MOCK_GAMES = [
  { gamePk:1, teams:{ home:{team:{id:147,teamName:"Yankees",abbreviation:"NYY"},probablePitcher:{lastName:"Cole",firstName:"Gerrit"}}, away:{team:{id:111,teamName:"Red Sox",abbreviation:"BOS"},probablePitcher:{lastName:"Pivetta",firstName:"Nick"}} }, venue:{name:"Yankee Stadium"}, gameDate:new Date().setHours(19,5) },
  { gamePk:2, teams:{ home:{team:{id:119,teamName:"Dodgers",abbreviation:"LAD"},probablePitcher:{lastName:"Yamamoto",firstName:"Yoshinobu"}}, away:{team:{id:135,teamName:"Padres",abbreviation:"SD"},probablePitcher:{lastName:"King",firstName:"Michael"}} }, venue:{name:"Dodger Stadium"}, gameDate:new Date().setHours(22,10) },
  { gamePk:3, teams:{ home:{team:{id:117,teamName:"Astros",abbreviation:"HOU"},probablePitcher:{lastName:"Valdez",firstName:"Framber"}}, away:{team:{id:136,teamName:"Mariners",abbreviation:"SEA"},probablePitcher:{lastName:"Gilbert",firstName:"Logan"}} }, venue:{name:"Minute Maid Park"}, gameDate:new Date().setHours(20,10) },
  { gamePk:4, teams:{ home:{team:{id:144,teamName:"Braves",abbreviation:"ATL"},probablePitcher:{lastName:"Sale",firstName:"Chris"}}, away:{team:{id:143,teamName:"Phillies",abbreviation:"PHI"},probablePitcher:{lastName:"Wheeler",firstName:"Zack"}} }, venue:{name:"Truist Park"}, gameDate:new Date().setHours(19,20) },
  { gamePk:5, teams:{ home:{team:{id:139,teamName:"Rays",abbreviation:"TB"},probablePitcher:{lastName:"Glasnow",firstName:"Tyler"}}, away:{team:{id:141,teamName:"Blue Jays",abbreviation:"TOR"},probablePitcher:{lastName:"Berrios",firstName:"Jose"}} }, venue:{name:"Tropicana Field"}, gameDate:new Date().setHours(18,50) },
  { gamePk:6, teams:{ home:{team:{id:114,teamName:"Guardians",abbreviation:"CLE"},probablePitcher:{lastName:"Bibee",firstName:"Tanner"}}, away:{team:{id:112,teamName:"Cubs",abbreviation:"CHC"},probablePitcher:{lastName:"Imanaga",firstName:"Shota"}} }, venue:{name:"Progressive Field"}, gameDate:new Date().setHours(18,40) },
  { gamePk:7, teams:{ home:{team:{id:117,teamName:"Rangers",abbreviation:"TEX"},probablePitcher:{lastName:"Heaney",firstName:"Andrew"}}, away:{team:{id:108,teamName:"Angels",abbreviation:"LAA"},probablePitcher:{lastName:"Detmers",firstName:"Reid"}} }, venue:{name:"Globe Life Field"}, gameDate:new Date().setHours(20,5) },
  { gamePk:8, teams:{ home:{team:{id:110,teamName:"Orioles",abbreviation:"BAL"},probablePitcher:{lastName:"Means",firstName:"John"}}, away:{team:{id:116,teamName:"Tigers",abbreviation:"DET"},probablePitcher:{lastName:"Skubal",firstName:"Tarik"}} }, venue:{name:"Camden Yards"}, gameDate:new Date().setHours(19,5) },
];

// ─── UI COMPONENTS ────────────────────────────────────────────────────────────
const Badge = ({ text, color }) => (
  <span style={{ background:`${color}22`, color, border:`1px solid ${color}44`, borderRadius:"4px", padding:"2px 7px", fontSize:"10px", fontWeight:700, letterSpacing:"0.06em" }}>{text}</span>
);

const ModelBar = ({ label, score, hasData=true, color }) => (
  <div style={{ display:"flex", alignItems:"center", gap:"10px", marginBottom:"8px" }}>
    <span style={{ fontSize:"10px", color:"#5a7490", minWidth:"32px", fontWeight:700 }}>{label}</span>
    <div style={{ flex:1, height:"5px", background:"#0d1e33", borderRadius:"3px", overflow:"hidden" }}>
      {hasData && <div style={{ height:"100%", width:`${score}%`, background:color, borderRadius:"3px", transition:"width 0.8s cubic-bezier(.4,0,.2,1)" }} />}
    </div>
    <span style={{ fontSize:"11px", fontWeight:800, color:hasData?"#c8dae8":"#3a5068", minWidth:"36px", textAlign:"right" }}>
      {hasData ? score.toFixed(1) : "Sin data"}
    </span>
  </div>
);

const TendencyRow = ({ label, value }) => {
  const color = value==="En alza"?"#00e5a0":value==="En baja"?"#e85d04":"#3a5068";
  return (
    <div style={{ display:"flex", justifyContent:"space-between", padding:"5px 0", borderBottom:"1px solid #0d1e33" }}>
      <span style={{ fontSize:"10px", color:"#5a7490" }}>{label}</span>
      <span style={{ fontSize:"10px", fontWeight:800, color }}>{value}</span>
    </div>
  );
};

const StatRow = ({ label, value }) => (
  <div style={{ display:"flex", justifyContent:"space-between", padding:"5px 0", borderBottom:"1px solid #0d1e33" }}>
    <span style={{ fontSize:"10px", color:"#5a7490" }}>{label}</span>
    <span style={{ fontSize:"11px", fontWeight:800, color:"#c8dae8" }}>{value}</span>
  </div>
);

const GameAnalysis = ({ analysis:g, isOpen, onToggle }) => {
  const homeColor = "#2196f3";
  const awayColor = "#00e5a0";
  return (
    <div style={{ background:"#071320", border:"1px solid #1a2e45", borderRadius:"12px", marginBottom:"10px", overflow:"hidden" }}>
      <div onClick={onToggle} style={{ padding:"14px 18px", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:"10px" }}>
        <div>
          <div style={{ fontSize:"17px", fontWeight:900, letterSpacing:"0.06em", fontFamily:"'Barlow Condensed',sans-serif" }}>
            <span style={{ color:awayColor }}>{g.away.abbr}</span>
            <span style={{ color:"#2a3f55", margin:"0 8px" }}>@</span>
            <span style={{ color:homeColor }}>{g.home.abbr}</span>
          </div>
          <div style={{ fontSize:"10px", color:"#3a5068", marginTop:"2px" }}>Abridores · {g.awayPitcher} vs {g.homePitcher} · {g.time}</div>
        </div>
        <div style={{ display:"flex", gap:"8px", alignItems:"center" }}>
          <div style={{ background:"#00e5a018", border:"1px solid #00e5a044", borderRadius:"20px", padding:"4px 12px", fontSize:"11px", fontWeight:800, color:"#00e5a0" }}>
            {g.favorite} ML · {g.confidence}% conf.
          </div>
          <span style={{ color:"#3a5068", fontSize:"14px", transition:"transform 0.2s", transform:isOpen?"rotate(180deg)":"none", display:"inline-block" }}>▼</span>
        </div>
      </div>

      {isOpen && (
        <div style={{ borderTop:"1px solid #1a2e45" }}>
          {/* Top 4 metrics */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:"1px", background:"#1a2e45" }}>
            {[
              { label:"MARCADOR PROYECTADO", main:`${g.away.abbr} ${g.projAway} – ${g.projHome} ${g.home.abbr}`, sub:`Total proyectado ${g.ou}` },
              { label:"MERCADO O/U", main:g.ou.toString(), sub:`OU ${g.ou>8.5?"over":"under"} (${g.ou>8.5?"+0.3":"-0.2"})` },
              { label:"MODELO INTEGRADO", main:`${g.away.abbr} ${g.awayComposite} – ${g.homeComposite} ${g.home.abbr}`, sub:`Edge neto ${g.edgeNeto>0?"+":""}${g.edgeNeto}` },
              { label:"TENDENCIA GANADORA", main:g.favorite, sub:`${g.favProb>0.6?"Fuerte":"Neutral"} · ${g.favProb>0.6?"Fuerte":"Neutral"}`, accent:true },
            ].map((s,i) => (
              <div key={i} style={{ background:"#071320", padding:"14px 16px" }}>
                <div style={{ fontSize:"9px", color:"#3a5068", textTransform:"uppercase", letterSpacing:"0.12em", marginBottom:"6px" }}>{s.label}</div>
                <div style={{ fontSize:s.label==="MERCADO O/U"?"28px":"14px", fontWeight:900, color:s.accent?"#00e5a0":"#c8dae8", fontFamily:"'Barlow Condensed',sans-serif", lineHeight:1.1 }}>{s.main}</div>
                <div style={{ fontSize:"10px", color:"#3a5068", marginTop:"4px" }}>{s.sub}</div>
                {s.accent && <div style={{ width:"40px", height:"2px", background:"#00e5a0", marginTop:"6px", borderRadius:"1px" }} />}
              </div>
            ))}
          </div>

          {/* M1-M4 summary bar */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:"1px", background:"#1a2e45" }}>
            {["M1","M2","M3","M4"].map((m,i) => {
              const hScore = [g.models.home.m1,g.models.home.m2,g.models.home.m3||0,g.models.home.m4][i];
              const aScore = [g.models.away.m1,g.models.away.m2,g.models.away.m3||0,g.models.away.m4][i];
              const winner = hScore > aScore ? g.home.abbr : g.away.abbr;
              const score = Math.max(hScore, aScore);
              return (
                <div key={m} style={{ background:"#050f1c", padding:"10px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span style={{ fontSize:"11px", color:"#3a5068", fontWeight:700 }}>{m}</span>
                  <span style={{ fontSize:"13px", fontWeight:900, color:"#00e5a0" }}>{winner} {score.toFixed(1)}</span>
                </div>
              );
            })}
          </div>

          {/* Team detail panels */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"1px", background:"#1a2e45" }}>
            {[
              { team:g.away, models:g.models.away, label:"VISITANTE", color:awayColor, projRuns:g.projAway, pitcher:g.awayPitcher },
              { team:g.home, models:g.models.home, label:"LOCAL", color:homeColor, projRuns:g.projHome, pitcher:g.homePitcher },
            ].map(({ team,models,label,color,projRuns,pitcher }) => {
              const composite = (models.m1*0.30 + models.m2*0.25 + (models.m3||50)*0.25 + models.m4*0.20);
              return (
                <div key={team.abbr} style={{ background:"#071320", padding:"18px" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:"14px" }}>
                    <div>
                      <div style={{ fontSize:"9px", color:"#3a5068", textTransform:"uppercase", letterSpacing:"0.12em", marginBottom:"2px" }}>{label}</div>
                      <div style={{ fontSize:"22px", fontWeight:900, color, fontFamily:"'Barlow Condensed',sans-serif" }}>{team.name}</div>
                      <div style={{ fontSize:"10px", color:"#3a5068" }}>Abridor: <span style={{ color:"#8aa8c0" }}>{pitcher}</span></div>
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontSize:"36px", fontWeight:900, color, lineHeight:1, fontFamily:"'Barlow Condensed',sans-serif" }}>{composite.toFixed(1)}</div>
                      <div style={{ fontSize:"10px", color:"#3a5068", marginTop:"2px" }}>{composite>=58?"Fuerte":composite>=48?"Neutral":"Débil"}</div>
                      <div style={{ fontSize:"9px", color:"#3a5068" }}>Proyección: {projRuns} carr.</div>
                    </div>
                  </div>
                  <div style={{ marginBottom:"14px" }}>
                    <ModelBar label="M1" score={models.m1} color={color} />
                    <ModelBar label="M2" score={models.m2} color={color} />
                    <ModelBar label="M3" score={models.m3??0} hasData={models.m3!=null} color={color} />
                    <ModelBar label="M4" score={models.m4} color={color} />
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"12px" }}>
                    <div>
                      <div style={{ fontSize:"9px", color:"#3a5068", textTransform:"uppercase", letterSpacing:"0.12em", marginBottom:"8px" }}>Lectura Rápida</div>
                      <TendencyRow label="M1 tendencia" value={models.t1} />
                      <TendencyRow label="M2 tendencia" value={models.t2} />
                      <TendencyRow label="M3 tendencia" value={models.t3} />
                      <TendencyRow label="M4 tendencia" value={models.t4} />
                    </div>
                    <div>
                      <div style={{ fontSize:"9px", color:"#3a5068", textTransform:"uppercase", letterSpacing:"0.12em", marginBottom:"8px" }}>Producción / Daño</div>
                      <StatRow label="CF recientes" value={models.cfRecientes} />
                      <StatRow label="CC recientes" value={models.ccRecientes} />
                      <StatRow label="ERA abridor" value={models.eraAbridor.toFixed(2)} />
                      <StatRow label="RA bullpen" value={models.raBullpen.toFixed(2)} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Odds footer */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:"1px", background:"#1a2e45" }}>
            {[
              { label:`ML ${g.home.abbr}`, value:g.homeOdds, color:homeColor },
              { label:`ML ${g.away.abbr}`, value:g.awayOdds, color:awayColor },
              { label:`Over ${g.ou}`, value:g.ou>8.5?"-115":"+105", color:"#f59e0b" },
              { label:"Confianza", value:g.confidence+"%", color:g.confidence>=70?"#00e5a0":"#f59e0b" },
            ].map((s) => (
              <div key={s.label} style={{ background:"#050f1c", padding:"12px 16px", textAlign:"center" }}>
                <div style={{ fontSize:"9px", color:"#3a5068", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:"4px" }}>{s.label}</div>
                <div style={{ fontSize:"18px", fontWeight:900, color:s.color, fontFamily:"'Barlow Condensed',sans-serif" }}>{s.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const ParlayCard = ({ parlay, index }) => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background:"#071320", border:`1px solid ${parlay.color}33`, borderRadius:"12px", marginBottom:"10px", overflow:"hidden" }}>
      <div onClick={() => setOpen(o=>!o)} style={{ padding:"16px 18px", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center", gap:"12px" }}>
        <div style={{ display:"flex", alignItems:"center", gap:"10px" }}>
          <div style={{ width:"32px", height:"32px", borderRadius:"50%", background:`${parlay.color}20`, border:`2px solid ${parlay.color}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:"13px", fontWeight:900, color:parlay.color, flexShrink:0 }}>{index+1}</div>
          <div>
            <div style={{ fontSize:"13px", fontWeight:800 }}>{parlay.name}</div>
            <div style={{ fontSize:"10px", color:"#3a5068" }}>{parlay.picks.length} selecciones</div>
          </div>
        </div>
        <div style={{ display:"flex", gap:"16px", alignItems:"center", flexWrap:"wrap", justifyContent:"flex-end" }}>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:"9px", color:"#3a5068", textTransform:"uppercase" }}>Prob. combinada</div>
            <div style={{ fontSize:"14px", fontWeight:900, color:parlay.color }}>{parlay.combinedProb}%</div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:"9px", color:"#3a5068", textTransform:"uppercase" }}>Pago potencial</div>
            <div style={{ fontSize:"14px", fontWeight:900, color:"#00e5a0" }}>{parlay.payout}</div>
          </div>
          <span style={{ color:"#3a5068", fontSize:"14px", transition:"transform 0.2s", transform:open?"rotate(180deg)":"none", display:"inline-block" }}>▼</span>
        </div>
      </div>
      {open && (
        <div style={{ borderTop:`1px solid ${parlay.color}22`, padding:"4px 18px 16px" }}>
          {parlay.picks.map((pick,i) => (
            <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"9px 0", borderBottom:i<parlay.picks.length-1?"1px solid #0d1e33":"none" }}>
              <div>
                <div style={{ fontSize:"10px", color:"#3a5068", marginBottom:"2px" }}>{pick.game}</div>
                <div style={{ fontSize:"13px", fontWeight:700 }}>{pick.pick}</div>
              </div>
              <div style={{ display:"flex", gap:"8px", alignItems:"center" }}>
                <Badge text={pick.type} color={pick.type==="ML"?"#4a8ab5":pick.type==="RL"?"#e85d04":"#00e5a0"} />
                <span style={{ fontSize:"14px", fontWeight:900, color:parlay.color, fontFamily:"monospace", minWidth:"52px", textAlign:"right" }}>{pick.odds}</span>
              </div>
            </div>
          ))}
          <div style={{ marginTop:"12px", padding:"12px", background:"#040d18", borderRadius:"8px", display:"flex", gap:"20px", flexWrap:"wrap" }}>
            <div><span style={{ fontSize:"9px", color:"#3a5068" }}>PAGO x$10: </span><span style={{ fontSize:"13px", color:"#00e5a0", fontWeight:800 }}>${(10*parlay.payoutRaw).toFixed(0)}</span></div>
            <div><span style={{ fontSize:"9px", color:"#3a5068" }}>PAGO x$25: </span><span style={{ fontSize:"13px", color:"#00e5a0", fontWeight:800 }}>${(25*parlay.payoutRaw).toFixed(0)}</span></div>
            <div><span style={{ fontSize:"9px", color:"#3a5068" }}>PAGO x$100: </span><span style={{ fontSize:"13px", color:"#00e5a0", fontWeight:800 }}>${(100*parlay.payoutRaw).toFixed(0)}</span></div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("games");
  const [analyses, setAnalyses] = useState([]);
  const [parlays, setParlays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openGame, setOpenGame] = useState(null);
  const [dataSource, setDataSource] = useState("live");
  const [lastUpdate, setLastUpdate] = useState(null);

  const today = new Date().toLocaleDateString("es-MX", { weekday:"long", year:"numeric", month:"long", day:"numeric" });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [rawGames, standingsRaw] = await Promise.all([fetchTodayGames(), fetchStandings()]);
      if (!rawGames.length) throw new Error("no_games");

      const winPctMap = {};
      standingsRaw.forEach(div => {
        (div.teamRecords||[]).forEach(r => { winPctMap[r.team.id] = parseFloat(r.winningPercentage)||0.5; });
      });

      const teamIds = [...new Set(rawGames.flatMap(g=>[g.teams?.home?.team?.id,g.teams?.away?.team?.id]).filter(Boolean))];
      const teamStatsMap = {};
      await Promise.allSettled(teamIds.map(async (id) => {
        const stats = await fetchTeamStats(id);
        const hitting = stats.find(s=>s.group?.displayName==="hitting")?.splits?.[0]?.stat||{};
        const pitching = stats.find(s=>s.group?.displayName==="pitching")?.splits?.[0]?.stat||{};
        teamStatsMap[id] = { ops:parseFloat(hitting.ops)||0.730, era:parseFloat(pitching.era)||4.00, bullpenEra:parseFloat(pitching.era)*0.95||3.80, whip:parseFloat(pitching.whip)||1.25, runDiff:(parseInt(hitting.runs)||200)-(parseInt(pitching.runs)||200), parkFactor:100 };
      }));

      const result = rawGames.map(g => analyzeGame(g, winPctMap, teamStatsMap));
      setAnalyses(result);
      setParlays(buildParlays(result, 10, 10));
      setOpenGame(result[0]?.gameId || null);
      setDataSource("live");
    } catch {
      const result = MOCK_GAMES.map(g => analyzeGame(g, MOCK_WP, MOCK_STATS));
      setAnalyses(result);
      setParlays(buildParlays(result, 10, 10));
      setOpenGame(result[0]?.gameId || null);
      setDataSource("mock");
    }
    setLastUpdate(new Date().toLocaleTimeString("es-MX"));
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    const iv = setInterval(loadData, 60*60*1000);
    return () => clearInterval(iv);
  }, [loadData]);

  const TABS = [
    { id:"games", label:"⚾ Juegos del Día", count:analyses.length },
    { id:"parlays", label:"🎯 Parleys 10×10", count:parlays.length },
  ];

  return (
    <div style={{ minHeight:"100vh", background:"#040d18", color:"#c8dae8", fontFamily:"'IBM Plex Mono',monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&family=Barlow+Condensed:wght@700;900&display=swap');
        @keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
        @keyframes spin{to{transform:rotate(360deg)}}
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:5px}
        ::-webkit-scrollbar-track{background:#040d18}
        ::-webkit-scrollbar-thumb{background:#1a2e45;border-radius:3px}
      `}</style>

      <header style={{ background:"#050f1c", borderBottom:"1px solid #1a2e45", padding:"18px 24px 0", position:"sticky", top:0, zIndex:100 }}>
        <div style={{ maxWidth:"1100px", margin:"0 auto" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:"12px", marginBottom:"16px" }}>
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:"10px" }}>
                <span style={{ fontSize:"22px" }}>⚾</span>
                <h1 style={{ margin:0, fontSize:"20px", fontWeight:900, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.1em" }}>
                  MLB <span style={{ color:"#00e5a0" }}>ORACLE</span>
                </h1>
                <span style={{ background:dataSource==="live"?"#00e5a018":"#f59e0b18", color:dataSource==="live"?"#00e5a0":"#f59e0b", border:`1px solid ${dataSource==="live"?"#00e5a040":"#f59e0b40"}`, borderRadius:"20px", padding:"2px 10px", fontSize:"9px", fontWeight:700, letterSpacing:"0.1em" }}>
                  {dataSource==="live"?"● LIVE MLB API":"◉ DEMO MODE"}
                </span>
              </div>
              <div style={{ fontSize:"10px", color:"#3a5068", marginTop:"3px", textTransform:"capitalize" }}>{today}</div>
            </div>
            <div style={{ display:"flex", gap:"10px", alignItems:"center" }}>
              {lastUpdate && <span style={{ fontSize:"10px", color:"#3a5068" }}>↺ {lastUpdate}</span>}
              <button onClick={loadData} disabled={loading} style={{ background:loading?"#1a2e45":"#00e5a0", color:loading?"#3a5068":"#040d18", border:"none", borderRadius:"6px", padding:"8px 16px", fontSize:"11px", fontWeight:800, cursor:loading?"not-allowed":"pointer", fontFamily:"inherit" }}>
                {loading?"Cargando...":"↻ Actualizar"}
              </button>
            </div>
          </div>
          <div style={{ display:"flex", gap:"0" }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{ padding:"10px 22px", border:"none", background:"transparent", cursor:"pointer", fontSize:"12px", fontWeight:700, fontFamily:"inherit", letterSpacing:"0.06em", color:tab===t.id?"#f0f4f8":"#3a5068", borderBottom:tab===t.id?"2px solid #00e5a0":"2px solid transparent", transition:"all 0.15s" }}>
                {t.label} <span style={{ opacity:0.5 }}>({t.count})</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      <main style={{ maxWidth:"1100px", margin:"0 auto", padding:"20px 20px 60px" }}>
        {loading ? (
          <div style={{ textAlign:"center", padding:"100px 0" }}>
            <div style={{ fontSize:"44px", display:"inline-block", animation:"spin 1.2s linear infinite", marginBottom:"16px" }}>⚾</div>
            <div style={{ color:"#00e5a0", fontSize:"11px", letterSpacing:"0.15em" }}>CARGANDO MLB ORACLE...</div>
          </div>
        ) : (
          <div style={{ animation:"fadeUp 0.35s ease" }}>
            {tab==="games" && (
              <>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"16px", flexWrap:"wrap", gap:"8px" }}>
                  <span style={{ fontSize:"11px", color:"#3a5068", textTransform:"uppercase", letterSpacing:"0.1em" }}>{analyses.length} juegos · click para análisis completo</span>
                  <span style={{ fontSize:"10px", color:"#3a5068" }}>M1: Abridor · M2: Equipo · M3: Matchup · M4: H2H</span>
                </div>
                {analyses.map(g => (
                  <GameAnalysis key={g.gameId} analysis={g} isOpen={openGame===g.gameId} onToggle={() => setOpenGame(openGame===g.gameId?null:g.gameId)} />
                ))}
              </>
            )}

            {tab==="parlays" && (
              <>
                <div style={{ background:"#071320", border:"1px solid #f59e0b33", borderRadius:"10px", padding:"14px 18px", marginBottom:"18px", display:"flex", gap:"10px" }}>
                  <span style={{ fontSize:"16px" }}>⚠️</span>
                  <div style={{ fontSize:"11px", color:"#5a7490", lineHeight:1.7 }}>
                    <strong style={{ color:"#f59e0b" }}>Aviso: </strong>
                    Parleys generados por modelo estadístico. No garantizan ganancias. Apuesta con responsabilidad.
                  </div>
                </div>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"16px", flexWrap:"wrap", gap:"8px" }}>
                  <span style={{ fontSize:"11px", color:"#3a5068", textTransform:"uppercase", letterSpacing:"0.1em" }}>10 parleys · 10 selecciones c/u · ML + RL + O/U</span>
                </div>
                {parlays.length===0
                  ? <div style={{ textAlign:"center", padding:"80px", color:"#3a5068" }}>🎯 Se necesitan más juegos para generar parleys</div>
                  : parlays.map((p,i) => <ParlayCard key={p.id} parlay={p} index={i} />)
                }
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
