import { useState, useEffect, useCallback } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API = "/mlb-api";
const TZ = "America/Los_Angeles"; // Hora del Pacífico

const fmtTime = (dateVal) => {
  if (!dateVal) return "TBD";
  return new Date(dateVal).toLocaleTimeString("es-MX", {
    hour: "2-digit", minute: "2-digit", timeZone: TZ
  }) + " PT";
};

// ─── MLB API ──────────────────────────────────────────────────────────────────
const fetchTodayGames = async () => {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const res = await fetch(`${API}/schedule?sportId=1&date=${today}&hydrate=team,linescore,probablePitcher,person,venue,stats`);
  if (!res.ok) throw new Error("API error");
  const data = await res.json();
  return data.dates?.[0]?.games || [];
};

const fetchStandings = async () => {
  const season = new Date().getFullYear();
  const res = await fetch(`${API}/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`);
  if (!res.ok) throw new Error("standings error");
  return (await res.json()).records || [];
};

const fetchTeamStats = async (teamId) => {
  try {
    const season = new Date().getFullYear();
    const res = await fetch(`${API}/teams/${teamId}/stats?stats=season&group=hitting,pitching&season=${season}`);
    return (await res.json()).stats || [];
  } catch { return []; }
};

// Fetch roster for player props
const fetchRoster = async (teamId) => {
  try {
    const res = await fetch(`${API}/teams/${teamId}/roster?rosterType=active`);
    return (await res.json()).roster || [];
  } catch { return []; }
};

// ─── MATH ENGINE ─────────────────────────────────────────────────────────────
const log5 = (pA, pB) => {
  const n = pA - pA * pB, d = pA + pB - 2 * pA * pB;
  return d === 0 ? 0.5 : Math.min(0.93, Math.max(0.07, n / d));
};
const eraToRunFactor = (era) => Math.max(0.5, Math.min(1.5, (4.5 - era) / 4.5 + 1));
const opsToRunFactor = (ops) => 0.5 + (ops / 0.750) * 0.5;
const norm = (val, min, max) => Math.round(Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100)));
const toAmerican = (p) => {
  if (p <= 0 || p >= 1) return "N/A";
  return p >= 0.5 ? `-${Math.round((p / (1 - p)) * 100)}` : `+${Math.round(((1 - p) / p) * 100)}`;
};
const probToDecimal = (p) => p <= 0 ? 1 : 1 / p;

// ─── PLAYER PROPS ENGINE ──────────────────────────────────────────────────────
// Genera props de jugadores basados en estadísticas del equipo y ERA del rival
const generatePlayerProps = (analyses, teamStatsMap) => {
  const props = [];

  // Props de pitchers abridores
  const pitcherProps = [
    { stat: "Ponches (K)", line: 5.5, overKey: "k9_high", baseProb: 0.54 },
    { stat: "Ponches (K)", line: 4.5, overKey: "k9_med",  baseProb: 0.63 },
    { stat: "Innings Lanzados", line: 5.5, overKey: "ip_high", baseProb: 0.52 },
  ];

  // Props de bateadores
  const batterProps = [
    { stat: "Hits", line: 0.5, overKey: "hits_half", baseProb: 0.62 },
    { stat: "Total Bases", line: 1.5, overKey: "tb_1", baseProb: 0.55 },
    { stat: "Carreras + CI", line: 0.5, overKey: "rbi_run", baseProb: 0.52 },
    { stat: "HR", line: 0.5, overKey: "hr", baseProb: 0.12 },
    { stat: "Hits", line: 1.5, overKey: "hits_1", baseProb: 0.38 },
  ];

  // Mock elite players per team with realistic 2025 stats
  const elitePlayers = {
    // [teamAbbr]: [{name, pos, avg, ops, hr, rbi, k9, era}]
    NYY: [
      { name: "A. Judge",    pos: "RF", avg: 0.290, ops: 1.020, hr: 18, rbi: 52, type: "bat" },
      { name: "J. Soto",     pos: "LF", avg: 0.278, ops: 0.930, hr: 12, rbi: 41, type: "bat" },
      { name: "G. Cole",     pos: "SP", era: 3.10, k9: 10.8, ip: 6.1, type: "pit" },
    ],
    LAD: [
      { name: "F. Freeman",  pos: "1B", avg: 0.305, ops: 0.990, hr: 14, rbi: 55, type: "bat" },
      { name: "S. Ohtani",   pos: "DH", avg: 0.295, ops: 1.010, hr: 22, rbi: 58, type: "bat" },
      { name: "Y. Yamamoto", pos: "SP", era: 3.05, k9: 9.8,  ip: 6.2, type: "pit" },
    ],
    HOU: [
      { name: "J. Altuve",   pos: "2B", avg: 0.285, ops: 0.830, hr: 8,  rbi: 38, type: "bat" },
      { name: "Y. Alvarez",  pos: "DH", avg: 0.295, ops: 0.970, hr: 15, rbi: 50, type: "bat" },
      { name: "F. Valdez",   pos: "SP", era: 3.45, k9: 8.2,  ip: 5.9, type: "pit" },
    ],
    ATL: [
      { name: "R. Acuña",    pos: "RF", avg: 0.300, ops: 0.960, hr: 12, rbi: 44, type: "bat" },
      { name: "M. Olson",    pos: "1B", avg: 0.265, ops: 0.880, hr: 16, rbi: 51, type: "bat" },
      { name: "C. Sale",     pos: "SP", era: 3.30, k9: 10.2, ip: 6.0, type: "pit" },
    ],
    BOS: [
      { name: "R. Devers",   pos: "3B", avg: 0.278, ops: 0.890, hr: 14, rbi: 48, type: "bat" },
      { name: "T. Turner",   pos: "SS", avg: 0.292, ops: 0.840, hr: 6,  rbi: 32, type: "bat" },
      { name: "N. Pivetta",  pos: "SP", era: 4.20, k9: 8.8,  ip: 5.5, type: "pit" },
    ],
    SD:  [
      { name: "X. Bogaerts", pos: "SS", avg: 0.270, ops: 0.800, hr: 8,  rbi: 36, type: "bat" },
      { name: "J. Profar",   pos: "LF", avg: 0.305, ops: 0.860, hr: 10, rbi: 40, type: "bat" },
      { name: "M. King",     pos: "SP", era: 3.55, k9: 9.1,  ip: 5.8, type: "pit" },
    ],
    SEA: [
      { name: "J. Rodriguez", pos: "CF", avg: 0.280, ops: 0.850, hr: 10, rbi: 40, type: "bat" },
      { name: "C. Raleigh",   pos: "C",  avg: 0.240, ops: 0.830, hr: 14, rbi: 44, type: "bat" },
      { name: "L. Gilbert",   pos: "SP", era: 3.25, k9: 9.5,  ip: 6.3, type: "pit" },
    ],
    PHI: [
      { name: "B. Harper",   pos: "1B", avg: 0.298, ops: 0.980, hr: 16, rbi: 52, type: "bat" },
      { name: "T. Turner",   pos: "SS", avg: 0.295, ops: 0.890, hr: 9,  rbi: 38, type: "bat" },
      { name: "Z. Wheeler",  pos: "SP", era: 3.10, k9: 10.5, ip: 6.4, type: "pit" },
    ],
    CLE: [
      { name: "J. Ramírez",  pos: "3B", avg: 0.285, ops: 0.920, hr: 16, rbi: 58, type: "bat" },
      { name: "S. Kwan",     pos: "LF", avg: 0.290, ops: 0.810, hr: 4,  rbi: 28, type: "bat" },
      { name: "T. Bibee",    pos: "SP", era: 3.60, k9: 9.2,  ip: 5.8, type: "pit" },
    ],
    TOR: [
      { name: "V. Guerrero", pos: "1B", avg: 0.295, ops: 0.940, hr: 18, rbi: 55, type: "bat" },
      { name: "D. Springer", pos: "CF", avg: 0.258, ops: 0.800, hr: 10, rbi: 36, type: "bat" },
      { name: "J. Berrios",  pos: "SP", era: 3.80, k9: 8.5,  ip: 5.9, type: "pit" },
    ],
    TB:  [
      { name: "Y. Díaz",     pos: "1B", avg: 0.268, ops: 0.830, hr: 12, rbi: 42, type: "bat" },
      { name: "B. Lowe",     pos: "2B", avg: 0.262, ops: 0.820, hr: 10, rbi: 36, type: "bat" },
      { name: "T. Glasnow",  pos: "SP", era: 3.20, k9: 11.5, ip: 6.1, type: "pit" },
    ],
    CHC: [
      { name: "I. Happ",     pos: "LF", avg: 0.262, ops: 0.810, hr: 9,  rbi: 34, type: "bat" },
      { name: "S. Suzuki",   pos: "RF", avg: 0.275, ops: 0.820, hr: 8,  rbi: 30, type: "bat" },
      { name: "S. Imanaga",  pos: "SP", era: 3.35, k9: 10.1, ip: 6.2, type: "pit" },
    ],
  };

  analyses.forEach((g) => {
    const rivalERA = (teamStatsMap[g.home.id]?.era || 4.0);
    const rivalOPS = (teamStatsMap[g.away.id]?.ops || 0.730);

    [g.home, g.away].forEach((team) => {
      const players = elitePlayers[team.abbr] || [];
      const rivalPitchingEra = team.abbr === g.home.abbr
        ? (teamStatsMap[g.away.id]?.era || 4.0)
        : (teamStatsMap[g.home.id]?.era || 4.0);

      players.forEach((p) => {
        if (p.type === "pit") {
          // Pitcher K prop
          const kAdj = (p.k9 / 9) * (1 + (rivalOPS - 0.730) * 0.5);
          const kProb5 = Math.min(0.82, Math.max(0.35, 0.50 + (p.k9 - 8.5) * 0.04));
          const kProb4 = Math.min(0.88, kProb5 + 0.12);
          const ipProb = Math.min(0.78, Math.max(0.35, 0.50 + (p.ip - 5.5) * 0.08));

          props.push({
            player: p.name, team: team.abbr, pos: p.pos,
            game: `${g.away.abbr} @ ${g.home.abbr}`,
            prop: `Más de 5.5 K`, type: "PITCHER",
            prob: kProb5, odds: toAmerican(kProb5),
            confidence: Math.round(kProb5 * 100),
            stat: `ERA ${p.era} · K/9 ${p.k9}`,
            value: kProb5 * 80,
          });
          props.push({
            player: p.name, team: team.abbr, pos: p.pos,
            game: `${g.away.abbr} @ ${g.home.abbr}`,
            prop: `Más de 4.5 K`, type: "PITCHER",
            prob: kProb4, odds: toAmerican(kProb4),
            confidence: Math.round(kProb4 * 100),
            stat: `ERA ${p.era} · K/9 ${p.k9}`,
            value: kProb4 * 70,
          });
          props.push({
            player: p.name, team: team.abbr, pos: p.pos,
            game: `${g.away.abbr} @ ${g.home.abbr}`,
            prop: `Más de 5.5 IP`, type: "PITCHER",
            prob: ipProb, odds: toAmerican(ipProb),
            confidence: Math.round(ipProb * 100),
            stat: `ERA ${p.era} · IP prom ${p.ip}`,
            value: ipProb * 65,
          });
        } else {
          // Batter props
          const hitProb = Math.min(0.80, Math.max(0.30, 0.55 + (p.avg - 0.260) * 2.0 - (rivalPitchingEra - 4.0) * 0.04));
          const tbProb  = Math.min(0.75, Math.max(0.30, 0.48 + (p.ops - 0.800) * 0.8));
          const rbiProb = Math.min(0.70, Math.max(0.25, 0.45 + (p.rbi / 162) * 3.0));
          const hrProb  = Math.min(0.22, Math.max(0.06, (p.hr / 162) * 1.8));

          props.push({
            player: p.name, team: team.abbr, pos: p.pos,
            game: `${g.away.abbr} @ ${g.home.abbr}`,
            prop: `Más de 0.5 Hits`, type: "BATEADOR",
            prob: hitProb, odds: toAmerican(hitProb),
            confidence: Math.round(hitProb * 100),
            stat: `AVG .${Math.round(p.avg*1000)} · OPS .${Math.round(p.ops*1000)}`,
            value: hitProb * 75,
          });
          props.push({
            player: p.name, team: team.abbr, pos: p.pos,
            game: `${g.away.abbr} @ ${g.home.abbr}`,
            prop: `Más de 1.5 Bases Totales`, type: "BATEADOR",
            prob: tbProb, odds: toAmerican(tbProb),
            confidence: Math.round(tbProb * 100),
            stat: `OPS .${Math.round(p.ops*1000)} · HR ${p.hr}`,
            value: tbProb * 68,
          });
          props.push({
            player: p.name, team: team.abbr, pos: p.pos,
            game: `${g.away.abbr} @ ${g.home.abbr}`,
            prop: `Más de 0.5 Carreras+CI`, type: "BATEADOR",
            prob: rbiProb, odds: toAmerican(rbiProb),
            confidence: Math.round(rbiProb * 100),
            stat: `RBI ${p.rbi} · HR ${p.hr}`,
            value: rbiProb * 60,
          });
          if (p.hr >= 12) {
            props.push({
              player: p.name, team: team.abbr, pos: p.pos,
              game: `${g.away.abbr} @ ${g.home.abbr}`,
              prop: `Más de 0.5 HR`, type: "BATEADOR",
              prob: hrProb, odds: toAmerican(hrProb),
              confidence: Math.round(hrProb * 100),
              stat: `HR ${p.hr} en temporada`,
              value: hrProb * 90,
            });
          }
        }
      });
    });
  });

  return props.sort((a, b) => b.value - a.value);
};

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
  const homePitcher = game.teams?.home?.probablePitcher ? `${game.teams.home.probablePitcher.lastName}.${(game.teams.home.probablePitcher.firstName||"")[0]||""}` : "TBD";
  const awayPitcher = game.teams?.away?.probablePitcher ? `${game.teams.away.probablePitcher.lastName}.${(game.teams.away.probablePitcher.firstName||"")[0]||""}` : "TBD";
  const hs = teamStatsMap[homeId] || {}, as = teamStatsMap[awayId] || {};
  const homeOPS=hs.ops||0.730, awayOPS=as.ops||0.730;
  const homeERA=hs.era||4.00, awayERA=as.era||4.00;
  const homeM1=norm(1/(homeERA*(hs.whip||1.25)),1/(14),1/(1.6));
  const awayM1=norm(1/(awayERA*(as.whip||1.25)),1/(14),1/(1.6));
  const homeM2=norm(hWp,0.35,0.70), awayM2=norm(aWp,0.35,0.70);
  const homeM3=norm(opsToRunFactor(awayOPS)/eraToRunFactor(homeERA),0.4,1.6);
  const awayM3=norm(opsToRunFactor(homeOPS)/eraToRunFactor(awayERA),0.4,1.6);
  const homeM4=norm(hs.runDiff||0,-80,80), awayM4=norm(as.runDiff||0,-80,80);
  const homeComp=homeM1*0.30+homeM2*0.25+homeM3*0.25+homeM4*0.20;
  const awayComp=awayM1*0.30+awayM2*0.25+awayM3*0.25+awayM4*0.20;
  const homeWinProb=log5(Math.min(0.94,hWp*1.04),Math.min(0.94,aWp*0.96));
  const awayWinProb=1-homeWinProb;
  const homeRS=4.3*opsToRunFactor(homeOPS)*eraToRunFactor(awayERA)*((hs.parkFactor||100)/100);
  const awayRS=4.3*opsToRunFactor(awayOPS)*eraToRunFactor(homeERA)*((hs.parkFactor||100)/100);
  const tend=(m1,m2,m4)=>{ const a=(m1+m2+m4)/3; return a>=60?"En alza":a<=40?"En baja":"Sin data"; };
  const confidence=Math.min(95,Math.round(50+Math.abs(homeComp-awayComp)*0.6));
  return {
    gameId:game.gamePk||Math.random(),
    home:{name:homeName,abbr:homeAbbr,id:homeId},
    away:{name:awayName,abbr:awayAbbr,id:awayId},
    homePitcher,awayPitcher,
    venue:game.venue?.name||"",
    time:fmtTime(game.gameDate),
    homeWinProb:Math.round(homeWinProb*100),
    awayWinProb:Math.round(awayWinProb*100),
    projHome:+homeRS.toFixed(1), projAway:+awayRS.toFixed(1),
    ou:+(homeRS+awayRS).toFixed(1),
    homeComposite:+homeComp.toFixed(1), awayComposite:+awayComp.toFixed(1),
    models:{
      home:{m1:homeM1,m2:homeM2,m3:homeM3,m4:homeM4,t1:tend(homeM1,homeM2,homeM4),t2:tend(homeM1,homeM2,homeM4),t3:tend(homeM3,homeM2,homeM4),t4:tend(homeM4,homeM2,homeM1),cfRecientes:+homeRS.toFixed(2),ccRecientes:+(homeRS*0.85).toFixed(2),eraAbridor:homeERA,raBullpen:hs.bullpenEra||3.80},
      away:{m1:awayM1,m2:awayM2,m3:awayM3,m4:awayM4,t1:tend(awayM1,awayM2,awayM4),t2:tend(awayM1,awayM2,awayM4),t3:tend(awayM3,awayM2,awayM4),t4:tend(awayM4,awayM2,awayM1),cfRecientes:+awayRS.toFixed(2),ccRecientes:+(awayRS*0.85).toFixed(2),eraAbridor:awayERA,raBullpen:as.bullpenEra||3.80},
    },
    edgeNeto:+(homeComp-awayComp).toFixed(1),
    confidence,
    favorite:homeWinProb>=0.5?homeAbbr:awayAbbr,
    favProb:Math.max(homeWinProb,awayWinProb),
    homeOdds:toAmerican(homeWinProb),
    awayOdds:toAmerican(awayWinProb),
  };
};

// ─── TRUE NUMBER ENGINE ───────────────────────────────────────────────────────
// Detecta si la línea del mercado es TRAMPA o FAIR comparando con el True Number
// calculado internamente a partir de proyecciones de carreras y diferencial de modelos.
//
// Lógica:
//   TN_spread = diferencial proyectado de carreras × factor de ventaja compuesta
//   TN_ou     = total proyectado × factor de parque y clima
//   Si |spread_mercado - TN_spread| > umbral → TRAMPA (mercado alejado de valor real)
//   Si |ou_mercado - TN_ou| > umbral         → TRAMPA
//   Probabilidad = función logística del edge detectado

const calcTrueNumber = (analyses) => {
  return analyses.map((g) => {
    const runDiff   = g.projHome - g.projAway;          // positivo = local favorito
    const totalProj = g.projHome + g.projAway;

    // True Number spread: diferencial proyectado + ajuste compuesto
    const edgeAdj   = (g.homeComposite - g.awayComposite) * 0.08;
    const tnSpread  = +(runDiff + edgeAdj).toFixed(1);

    // True Number OU: total proyectado ajustado por factor de modelo integrado
    const modelAvg  = (g.homeComposite + g.awayComposite) / 2;
    const ouAdj     = (modelAvg - 50) * 0.05;
    const tnOU      = +(totalProj + ouAdj).toFixed(1);

    // Línea de mercado simulada (en live usaría la API de odds)
    // Usamos winProb para inferir spread implícito del mercado
    const impliedSpreadMkt = (g.homeWinProb - 50) * 0.12;
    const impliedOUMkt     = totalProj * (1 + (g.homeWinProb - 50) * 0.001);

    const spreadDiff = Math.abs(impliedSpreadMkt - tnSpread);
    const ouDiff     = Math.abs(impliedOUMkt     - tnOU);

    // Umbrales calibrados (béisbol: 1.5 carreras spread, 0.8 OU)
    const spreadTrap = spreadDiff > 1.5;
    const ouTrap     = ouDiff     > 0.8;

    // Probabilidad logística basada en edge total
    const totalEdge  = spreadDiff * 0.4 + ouDiff * 0.6;
    const prob       = Math.round(Math.min(92, Math.max(51, 50 + totalEdge * 12)));

    // Recomendación: equipo del lado del TN
    const recTeam = tnSpread >= 0 ? g.home.abbr : g.away.abbr;
    const recLine = Math.abs(tnSpread).toFixed(1);

    // Mejor pick del juego para el reporte
    const bestPick = spreadTrap
      ? `${recTeam} ${tnSpread >= 0 ? "-" : "+"}${recLine}`
      : `${g.favorite} ML`;

    return {
      game:       `${g.away.abbr} @ ${g.home.abbr}`,
      home:       g.home.abbr,
      away:       g.away.abbr,
      time:       g.time,
      spreadMkt:  +impliedSpreadMkt.toFixed(1),
      tnSpread,
      spreadEval: spreadTrap ? "TRAMPA" : "FAIR",
      ouMkt:      +impliedOUMkt.toFixed(1),
      tnOU,
      ouEval:     ouTrap ? "TRAMPA" : "FAIR",
      bestPick,
      prob,
      isBest:     prob >= 72 && spreadTrap,
      projHome:   g.projHome,
      projAway:   g.projAway,
      favorite:   g.favorite,
    };
  }).sort((a, b) => b.prob - a.prob);
};

// ─── MAXMIN ENGINE ────────────────────────────────────────────────────────────
// Clasifica juegos en 4 cuadrantes usando distribución de Poisson simplificada:
//   P(X < 7)  = Poisson acumulada con λ = total proyectado
//   P(X >= 7) = 1 - P(X < 7)
//   P(equipo >= 4 carr) = 1 - Poisson(3, λ_equipo)
//   P(equipo <  4 carr) = Poisson(3, λ_equipo)

const poissonCDF = (lambda, k) => {
  // P(X <= k) con distribución de Poisson
  let sum = 0, term = Math.exp(-lambda);
  for (let i = 0; i <= k; i++) {
    sum += term;
    term *= lambda / (i + 1);
  }
  return Math.min(1, sum);
};

const calcMaxMin = (analyses) => {
  const gameData = analyses.map((g) => {
    const λHome = Math.max(0.5, g.projHome);
    const λAway = Math.max(0.5, g.projAway);
    const λTotal = λHome + λAway;

    // OU probabilities
    const probUnder7 = poissonCDF(λTotal, 6);         // P(total <= 6)
    const probOver7  = 1 - poissonCDF(λTotal, 6);     // P(total >= 7)

    // Run scoring probabilities per team
    const probHome4plus = 1 - poissonCDF(λHome, 3);   // P(home >= 4)
    const probAway4plus = 1 - poissonCDF(λAway, 3);   // P(away >= 4)
    const probHomeSub4  = poissonCDF(λHome, 3);        // P(home < 4)
    const probAwaySub4  = poissonCDF(λAway, 3);        // P(away < 4)

    return {
      game:        `${g.away.abbr} @ ${g.home.abbr}`,
      home:        g.home.abbr,
      away:        g.away.abbr,
      homeName:    g.home.name,
      awayName:    g.away.name,
      time:        g.time,
      projHome:    g.projHome,
      projAway:    g.projAway,
      λTotal,
      probUnder7:  Math.round(probUnder7 * 100),
      probOver7:   Math.round(probOver7  * 100),
      probHome4p:  Math.round(probHome4plus * 100),
      probAway4p:  Math.round(probAway4plus * 100),
      probHomeSub: Math.round(probHomeSub4  * 100),
      probAwaySub: Math.round(probAwaySub4  * 100),
    };
  });

  // Top 3 por categoría
  const top3Under7  = [...gameData].sort((a,b)=>b.probUnder7-a.probUnder7).slice(0,3);
  const top3Over7   = [...gameData].sort((a,b)=>b.probOver7-a.probOver7).slice(0,3);

  // Top 3 equipos con mayor prob 4+ (mejor de home/away por juego)
  const teamScores4plus = [];
  const teamScoresSub4  = [];
  gameData.forEach(g => {
    teamScores4plus.push({ game:g.game, team:g.home, role:"Local",  prob:g.probHome4p, proj:g.projHome, rival:g.away });
    teamScores4plus.push({ game:g.game, team:g.away, role:"Visit.", prob:g.probAway4p, proj:g.projAway, rival:g.home });
    teamScoresSub4.push({ game:g.game, team:g.home, role:"Local",  prob:g.probHomeSub, proj:g.projHome, rival:g.away });
    teamScoresSub4.push({ game:g.game, team:g.away, role:"Visit.", prob:g.probAwaySub, proj:g.projAway, rival:g.home });
  });

  return {
    top3Under7,
    top3Over7,
    top3team4plus: [...teamScores4plus].sort((a,b)=>b.prob-a.prob).slice(0,3),
    top3teamSub4:  [...teamScoresSub4 ].sort((a,b)=>b.prob-a.prob).slice(0,3),
  };
};

// ─── PARLAY BUILDER (juegos + props combinados) ───────────────────────────────
const buildParlays = (predictions, playerProps) => {
  if (predictions.length < 3) return [];

  // Top props por valor (sin repetir jugador)
  const topProps = [];
  const seenPlayers = new Set();
  for (const p of playerProps) {
    if (!seenPlayers.has(p.player) && p.prob > 0.42 && topProps.length < 30) {
      seenPlayers.add(p.player);
      topProps.push(p);
    }
  }

  // Opciones por juego (1 selección de equipo por juego)
  const gameOptions = predictions.map((g) => {
    const hP=g.homeWinProb/100, aP=g.awayWinProb/100;
    const ou=g.ou, overProb=hP>0.55?0.54:0.48;
    const favP=Math.max(hP,aP), favA=hP>=aP?g.home.abbr:g.away.abbr;
    const cands = [
      { game:`${g.away.abbr}@${g.home.abbr}`, pick:favA, type:"ML", prob:favP, odds:toAmerican(favP), confidence:g.confidence, value:favP*g.confidence, isTeam:true },
      { game:`${g.away.abbr}@${g.home.abbr}`, pick:`OVER ${ou.toFixed(1)}`, type:"O/U", prob:overProb, odds:toAmerican(overProb), confidence:Math.round(overProb*100), value:overProb*52, isTeam:true },
      { game:`${g.away.abbr}@${g.home.abbr}`, pick:`UNDER ${ou.toFixed(1)}`, type:"O/U", prob:1-overProb, odds:toAmerican(1-overProb), confidence:Math.round((1-overProb)*100), value:(1-overProb)*50, isTeam:true },
    ];
    if (favP>0.60) cands.push({ game:`${g.away.abbr}@${g.home.abbr}`, pick:`${favA} -1.5`, type:"RL", prob:favP*0.72, odds:toAmerican(favP*0.72), confidence:Math.round(favP*72), value:favP*0.72*65, isTeam:true });
    return { gameKey:`${g.away.abbr}@${g.home.abbr}`, cands };
  });

  const strategies = [
    { name:"🔥 Alta Confianza",      color:"#e85d04", teamPick:(c)=>c.filter(x=>x.confidence>=58).sort((a,b)=>b.confidence-a.confidence)[0], propFilter:(p)=>p.confidence>=65, maxProps:3 },
    { name:"💎 ML Puro",             color:"#f59e0b", teamPick:(c)=>c.filter(x=>x.type==="ML")[0],                                            propFilter:(p)=>p.type==="BATEADOR", maxProps:3 },
    { name:"🎯 Mixto + Props",        color:"#00e5a0", teamPick:(c)=>[...c].sort((a,b)=>b.value-a.value)[0],                                   propFilter:(p)=>p.value>50, maxProps:4 },
    { name:"⚡ Run Lines + Props",    color:"#4a8ab5", teamPick:(c)=>c.find(x=>x.type==="RL")||c.filter(x=>x.type==="ML")[0],                  propFilter:(p)=>p.type==="PITCHER", maxProps:3 },
    { name:"📊 Totales + Props",      color:"#a855f7", teamPick:(c)=>c.filter(x=>x.type==="O/U").sort((a,b)=>b.prob-a.prob)[0],                propFilter:(p)=>p.confidence>=60, maxProps:3 },
    { name:"🔥 Favoritos + Bateo",    color:"#ec4899", teamPick:(c)=>c.filter(x=>x.type==="ML"&&x.prob>0.55)[0]||c[0],                         propFilter:(p)=>p.type==="BATEADOR"&&p.prob>0.58, maxProps:4 },
    { name:"💎 ML + Pitchers K",      color:"#06b6d4", teamPick:(c)=>c.filter(x=>x.type!=="O/U").sort((a,b)=>b.value-a.value)[0],             propFilter:(p)=>p.prop.includes("K")&&p.type==="PITCHER", maxProps:4 },
    { name:"🎯 Underdog + Props",     color:"#84cc16", teamPick:(c)=>[...c].filter(x=>x.prob<0.50).sort((a,b)=>b.prob-a.prob)[0]||c[0],        propFilter:(p)=>p.confidence>=55, maxProps:3 },
    { name:"⚡ Modelo Compuesto",     color:"#f97316", teamPick:(c)=>[...c].sort((a,b)=>b.prob*b.confidence-a.prob*a.confidence)[0],           propFilter:(p)=>p.value>55, maxProps:3 },
    { name:"📊 Máximo Valor",         color:"#6366f1", teamPick:(c)=>[...c].filter(x=>x.prob>0.35).sort((a,b)=>a.prob-b.prob)[0],              propFilter:(p)=>p.confidence>=58, maxProps:4 },
  ];

  return strategies.map((strat, i) => {
    // 1. Picks de equipo (1 por juego)
    const teamPicks = [];
    for (const { cands } of gameOptions) {
      const pick = strat.teamPick(cands);
      if (pick) teamPicks.push(pick);
    }

    // 2. Props de jugadores (sin repetir jugador, sin repetir juego ya en teamPicks si es el mismo)
    const usedGames = new Set(teamPicks.map(p => p.game));
    const propPicks = [];
    const usedPropPlayers = new Set();
    for (const prop of topProps) {
      if (propPicks.length >= strat.maxProps) break;
      if (!strat.propFilter(prop)) continue;
      if (usedPropPlayers.has(prop.player)) continue;
      propPicks.push({ ...prop, isTeam: false });
      usedPropPlayers.add(prop.player);
    }

    const allPicks = [...teamPicks, ...propPicks];
    if (allPicks.length < 3) return null;

    const combinedProb = allPicks.reduce((acc, p) => acc * p.prob, 1);
    const decimalPayout = allPicks.reduce((acc, p) => acc * probToDecimal(p.prob), 1);

    return {
      id: i+1, name:strat.name, color:strat.color,
      picks: allPicks,
      teamPicks: teamPicks.length,
      propPicks: propPicks.length,
      combinedProb: (combinedProb*100).toFixed(3),
      payout: `${Math.round(decimalPayout)}x`,
      payoutRaw: decimalPayout,
    };
  }).filter(Boolean);
};

// ─── MOCK DATA ────────────────────────────────────────────────────────────────
const MOCK_STATS = {
  147:{ops:0.765,era:3.42,bullpenEra:3.10,whip:1.18,runDiff:45,parkFactor:103},
  119:{ops:0.788,era:3.15,bullpenEra:2.90,whip:1.10,runDiff:62,parkFactor:96},
  117:{ops:0.748,era:3.58,bullpenEra:3.20,whip:1.22,runDiff:38,parkFactor:98},
  144:{ops:0.762,era:3.71,bullpenEra:3.45,whip:1.24,runDiff:41,parkFactor:100},
  139:{ops:0.718,era:3.55,bullpenEra:3.30,whip:1.21,runDiff:22,parkFactor:95},
  143:{ops:0.751,era:3.80,bullpenEra:3.60,whip:1.26,runDiff:28,parkFactor:101},
  141:{ops:0.742,era:3.91,bullpenEra:3.70,whip:1.28,runDiff:18,parkFactor:99},
  135:{ops:0.728,era:3.65,bullpenEra:3.40,whip:1.23,runDiff:20,parkFactor:92},
  136:{ops:0.704,era:3.38,bullpenEra:3.05,whip:1.16,runDiff:30,parkFactor:94},
  114:{ops:0.716,era:3.48,bullpenEra:3.15,whip:1.19,runDiff:25,parkFactor:97},
  111:{ops:0.749,era:4.12,bullpenEra:3.90,whip:1.31,runDiff:12,parkFactor:104},
  112:{ops:0.730,era:4.05,bullpenEra:3.85,whip:1.29,runDiff:8,parkFactor:101},
};
const MOCK_WP={147:0.580,119:0.625,117:0.555,144:0.570,139:0.532,143:0.555,141:0.518,135:0.540,136:0.525,114:0.548,111:0.510,112:0.495};
const MOCK_GAMES=[
  {gamePk:1,teams:{home:{team:{id:147,teamName:"Yankees",abbreviation:"NYY"},probablePitcher:{lastName:"Cole",firstName:"Gerrit"}},away:{team:{id:111,teamName:"Red Sox",abbreviation:"BOS"},probablePitcher:{lastName:"Pivetta",firstName:"Nick"}}},venue:{name:"Yankee Stadium"},gameDate:new Date().setHours(16,5)},
  {gamePk:2,teams:{home:{team:{id:119,teamName:"Dodgers",abbreviation:"LAD"},probablePitcher:{lastName:"Yamamoto",firstName:"Yoshinobu"}},away:{team:{id:135,teamName:"Padres",abbreviation:"SD"},probablePitcher:{lastName:"King",firstName:"Michael"}}},venue:{name:"Dodger Stadium"},gameDate:new Date().setHours(19,10)},
  {gamePk:3,teams:{home:{team:{id:117,teamName:"Astros",abbreviation:"HOU"},probablePitcher:{lastName:"Valdez",firstName:"Framber"}},away:{team:{id:136,teamName:"Mariners",abbreviation:"SEA"},probablePitcher:{lastName:"Gilbert",firstName:"Logan"}}},venue:{name:"Minute Maid Park"},gameDate:new Date().setHours(17,10)},
  {gamePk:4,teams:{home:{team:{id:144,teamName:"Braves",abbreviation:"ATL"},probablePitcher:{lastName:"Sale",firstName:"Chris"}},away:{team:{id:143,teamName:"Phillies",abbreviation:"PHI"},probablePitcher:{lastName:"Wheeler",firstName:"Zack"}}},venue:{name:"Truist Park"},gameDate:new Date().setHours(16,20)},
  {gamePk:5,teams:{home:{team:{id:139,teamName:"Rays",abbreviation:"TB"},probablePitcher:{lastName:"Glasnow",firstName:"Tyler"}},away:{team:{id:141,teamName:"Blue Jays",abbreviation:"TOR"},probablePitcher:{lastName:"Berrios",firstName:"Jose"}}},venue:{name:"Tropicana Field"},gameDate:new Date().setHours(15,50)},
  {gamePk:6,teams:{home:{team:{id:114,teamName:"Guardians",abbreviation:"CLE"},probablePitcher:{lastName:"Bibee",firstName:"Tanner"}},away:{team:{id:112,teamName:"Cubs",abbreviation:"CHC"},probablePitcher:{lastName:"Imanaga",firstName:"Shota"}}},venue:{name:"Progressive Field"},gameDate:new Date().setHours(15,40)},
  {gamePk:7,teams:{home:{team:{id:143,teamName:"Phillies",abbreviation:"PHI"},probablePitcher:{lastName:"Nola",firstName:"Aaron"}},away:{team:{id:144,teamName:"Braves",abbreviation:"ATL"},probablePitcher:{lastName:"Morton",firstName:"Charlie"}}},venue:{name:"Citizens Bank Park"},gameDate:new Date().setHours(17,5)},
  {gamePk:8,teams:{home:{team:{id:119,teamName:"Dodgers",abbreviation:"LAD"},probablePitcher:{lastName:"Buehler",firstName:"Walker"}},away:{team:{id:135,teamName:"Padres",abbreviation:"SD"},probablePitcher:{lastName:"Cease",firstName:"Dylan"}}},venue:{name:"Dodger Stadium"},gameDate:new Date().setHours(19,10)},
];

// ─── UI COMPONENTS ────────────────────────────────────────────────────────────
const Badge = ({ text, color }) => (
  <span style={{background:`${color}22`,color,border:`1px solid ${color}44`,borderRadius:"4px",padding:"2px 7px",fontSize:"10px",fontWeight:700,letterSpacing:"0.06em"}}>{text}</span>
);
const ModelBar = ({ label, score, hasData=true, color }) => (
  <div style={{display:"flex",alignItems:"center",gap:"10px",marginBottom:"8px"}}>
    <span style={{fontSize:"10px",color:"#5a7490",minWidth:"32px",fontWeight:700}}>{label}</span>
    <div style={{flex:1,height:"5px",background:"#0d1e33",borderRadius:"3px",overflow:"hidden"}}>
      {hasData&&<div style={{height:"100%",width:`${score}%`,background:color,borderRadius:"3px",transition:"width 0.8s cubic-bezier(.4,0,.2,1)"}}/>}
    </div>
    <span style={{fontSize:"11px",fontWeight:800,color:hasData?"#c8dae8":"#3a5068",minWidth:"36px",textAlign:"right"}}>
      {hasData?score.toFixed(1):"Sin data"}
    </span>
  </div>
);
const TendencyRow = ({ label, value }) => {
  const color=value==="En alza"?"#00e5a0":value==="En baja"?"#e85d04":"#3a5068";
  return <div style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid #0d1e33"}}><span style={{fontSize:"10px",color:"#5a7490"}}>{label}</span><span style={{fontSize:"10px",fontWeight:800,color}}>{value}</span></div>;
};
const StatRow = ({ label, value }) => (
  <div style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid #0d1e33"}}>
    <span style={{fontSize:"10px",color:"#5a7490"}}>{label}</span>
    <span style={{fontSize:"11px",fontWeight:800,color:"#c8dae8"}}>{value}</span>
  </div>
);

const GameAnalysis = ({ analysis:g, isOpen, onToggle }) => {
  const hC="#2196f3", aC="#00e5a0";
  return (
    <div style={{background:"#071320",border:"1px solid #1a2e45",borderRadius:"12px",marginBottom:"10px",overflow:"hidden"}}>
      <div onClick={onToggle} style={{padding:"14px 18px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:"10px"}}>
        <div>
          <div style={{fontSize:"17px",fontWeight:900,letterSpacing:"0.06em",fontFamily:"'Barlow Condensed',sans-serif"}}>
            <span style={{color:aC}}>{g.away.abbr}</span><span style={{color:"#2a3f55",margin:"0 8px"}}>@</span><span style={{color:hC}}>{g.home.abbr}</span>
          </div>
          <div style={{fontSize:"10px",color:"#3a5068",marginTop:"2px"}}>Abridores · {g.awayPitcher} vs {g.homePitcher} · {g.time}</div>
        </div>
        <div style={{display:"flex",gap:"8px",alignItems:"center"}}>
          <div style={{background:"#00e5a018",border:"1px solid #00e5a044",borderRadius:"20px",padding:"4px 12px",fontSize:"11px",fontWeight:800,color:"#00e5a0"}}>{g.favorite} ML · {g.confidence}% conf.</div>
          <span style={{color:"#3a5068",fontSize:"14px",transition:"transform 0.2s",transform:isOpen?"rotate(180deg)":"none",display:"inline-block"}}>▼</span>
        </div>
      </div>
      {isOpen&&(
        <div style={{borderTop:"1px solid #1a2e45"}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"1px",background:"#1a2e45"}}>
            {[
              {label:"MARCADOR PROYECTADO",main:`${g.away.abbr} ${g.projAway} – ${g.projHome} ${g.home.abbr}`,sub:`Total proyectado ${g.ou}`},
              {label:"MERCADO O/U",main:g.ou.toString(),sub:`OU ${g.ou>8.5?"over":"under"}`},
              {label:"MODELO INTEGRADO",main:`${g.away.abbr} ${g.awayComposite} – ${g.homeComposite} ${g.home.abbr}`,sub:`Edge neto ${g.edgeNeto>0?"+":""}${g.edgeNeto}`},
              {label:"TENDENCIA GANADORA",main:g.favorite,sub:`${g.favProb>0.6?"Fuerte":"Neutral"}`,accent:true},
            ].map((s,i)=>(
              <div key={i} style={{background:"#071320",padding:"14px 16px"}}>
                <div style={{fontSize:"9px",color:"#3a5068",textTransform:"uppercase",letterSpacing:"0.12em",marginBottom:"6px"}}>{s.label}</div>
                <div style={{fontSize:s.label==="MERCADO O/U"?"28px":"14px",fontWeight:900,color:s.accent?"#00e5a0":"#c8dae8",fontFamily:"'Barlow Condensed',sans-serif",lineHeight:1.1}}>{s.main}</div>
                <div style={{fontSize:"10px",color:"#3a5068",marginTop:"4px"}}>{s.sub}</div>
                {s.accent&&<div style={{width:"40px",height:"2px",background:"#00e5a0",marginTop:"6px",borderRadius:"1px"}}/>}
              </div>
            ))}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"1px",background:"#1a2e45"}}>
            {["M1","M2","M3","M4"].map((m,i)=>{
              const hs=[g.models.home.m1,g.models.home.m2,g.models.home.m3||0,g.models.home.m4][i];
              const as=[g.models.away.m1,g.models.away.m2,g.models.away.m3||0,g.models.away.m4][i];
              const w=hs>as?g.home.abbr:g.away.abbr;
              return <div key={m} style={{background:"#050f1c",padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:"11px",color:"#3a5068",fontWeight:700}}>{m}</span><span style={{fontSize:"13px",fontWeight:900,color:"#00e5a0"}}>{w} {Math.max(hs,as).toFixed(1)}</span></div>;
            })}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"1px",background:"#1a2e45"}}>
            {[
              {team:g.away,models:g.models.away,label:"VISITANTE",color:aC,projRuns:g.projAway,pitcher:g.awayPitcher},
              {team:g.home,models:g.models.home,label:"LOCAL",color:hC,projRuns:g.projHome,pitcher:g.homePitcher},
            ].map(({team,models,label,color,projRuns,pitcher})=>{
              const comp=models.m1*0.30+models.m2*0.25+(models.m3||50)*0.25+models.m4*0.20;
              return (
                <div key={team.abbr} style={{background:"#071320",padding:"18px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"14px"}}>
                    <div>
                      <div style={{fontSize:"9px",color:"#3a5068",textTransform:"uppercase",letterSpacing:"0.12em",marginBottom:"2px"}}>{label}</div>
                      <div style={{fontSize:"22px",fontWeight:900,color,fontFamily:"'Barlow Condensed',sans-serif"}}>{team.name}</div>
                      <div style={{fontSize:"10px",color:"#3a5068"}}>Abridor: <span style={{color:"#8aa8c0"}}>{pitcher}</span></div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:"36px",fontWeight:900,color,lineHeight:1,fontFamily:"'Barlow Condensed',sans-serif"}}>{comp.toFixed(1)}</div>
                      <div style={{fontSize:"10px",color:"#3a5068"}}>{comp>=58?"Fuerte":comp>=48?"Neutral":"Débil"}</div>
                      <div style={{fontSize:"9px",color:"#3a5068"}}>Proy: {projRuns} carr.</div>
                    </div>
                  </div>
                  <div style={{marginBottom:"14px"}}>
                    <ModelBar label="M1" score={models.m1} color={color}/>
                    <ModelBar label="M2" score={models.m2} color={color}/>
                    <ModelBar label="M3" score={models.m3??0} hasData={models.m3!=null} color={color}/>
                    <ModelBar label="M4" score={models.m4} color={color}/>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"12px"}}>
                    <div>
                      <div style={{fontSize:"9px",color:"#3a5068",textTransform:"uppercase",letterSpacing:"0.12em",marginBottom:"8px"}}>Lectura Rápida</div>
                      <TendencyRow label="M1 tendencia" value={models.t1}/>
                      <TendencyRow label="M2 tendencia" value={models.t2}/>
                      <TendencyRow label="M3 tendencia" value={models.t3}/>
                      <TendencyRow label="M4 tendencia" value={models.t4}/>
                    </div>
                    <div>
                      <div style={{fontSize:"9px",color:"#3a5068",textTransform:"uppercase",letterSpacing:"0.12em",marginBottom:"8px"}}>Producción / Daño</div>
                      <StatRow label="CF recientes" value={models.cfRecientes}/>
                      <StatRow label="CC recientes" value={models.ccRecientes}/>
                      <StatRow label="ERA abridor" value={models.eraAbridor.toFixed(2)}/>
                      <StatRow label="RA bullpen" value={models.raBullpen.toFixed(2)}/>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"1px",background:"#1a2e45"}}>
            {[
              {label:`ML ${g.home.abbr}`,value:g.homeOdds,color:hC},
              {label:`ML ${g.away.abbr}`,value:g.awayOdds,color:aC},
              {label:`Over ${g.ou}`,value:g.ou>8.5?"-115":"+105",color:"#f59e0b"},
              {label:"Confianza",value:g.confidence+"%",color:g.confidence>=70?"#00e5a0":"#f59e0b"},
            ].map(s=>(
              <div key={s.label} style={{background:"#050f1c",padding:"12px 16px",textAlign:"center"}}>
                <div style={{fontSize:"9px",color:"#3a5068",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:"4px"}}>{s.label}</div>
                <div style={{fontSize:"18px",fontWeight:900,color:s.color,fontFamily:"'Barlow Condensed',sans-serif"}}>{s.value}</div>
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
    <div style={{background:"#071320",border:`1px solid ${parlay.color}33`,borderRadius:"12px",marginBottom:"10px",overflow:"hidden"}}>
      <div onClick={()=>setOpen(o=>!o)} style={{padding:"16px 18px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",gap:"12px",flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:"10px"}}>
          <div style={{width:"32px",height:"32px",borderRadius:"50%",background:`${parlay.color}20`,border:`2px solid ${parlay.color}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:"13px",fontWeight:900,color:parlay.color,flexShrink:0}}>{index+1}</div>
          <div>
            <div style={{fontSize:"13px",fontWeight:800}}>{parlay.name}</div>
            <div style={{fontSize:"10px",color:"#3a5068"}}>
              {parlay.teamPicks} equipos · {parlay.propPicks} props · {parlay.picks.length} total
            </div>
          </div>
        </div>
        <div style={{display:"flex",gap:"16px",alignItems:"center",flexWrap:"wrap",justifyContent:"flex-end"}}>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:"9px",color:"#3a5068",textTransform:"uppercase"}}>Prob. combinada</div>
            <div style={{fontSize:"14px",fontWeight:900,color:parlay.color}}>{parlay.combinedProb}%</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:"9px",color:"#3a5068",textTransform:"uppercase"}}>Pago potencial</div>
            <div style={{fontSize:"14px",fontWeight:900,color:"#00e5a0"}}>{parlay.payout}</div>
          </div>
          <span style={{color:"#3a5068",fontSize:"14px",transition:"transform 0.2s",transform:open?"rotate(180deg)":"none",display:"inline-block"}}>▼</span>
        </div>
      </div>
      {open&&(
        <div style={{borderTop:`1px solid ${parlay.color}22`,padding:"4px 18px 16px"}}>
          {/* Team picks section */}
          {parlay.picks.filter(p=>p.isTeam).length>0&&(
            <div style={{marginBottom:"8px",paddingTop:"10px"}}>
              <div style={{fontSize:"9px",color:"#3a5068",textTransform:"uppercase",letterSpacing:"0.12em",marginBottom:"6px",paddingLeft:"2px"}}>📋 Selecciones de Equipo</div>
              {parlay.picks.filter(p=>p.isTeam).map((pick,i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #0d1e33"}}>
                  <div>
                    <div style={{fontSize:"10px",color:"#3a5068",marginBottom:"2px"}}>{pick.game.replace("@"," @ ")}</div>
                    <div style={{fontSize:"13px",fontWeight:700}}>{pick.pick}</div>
                  </div>
                  <div style={{display:"flex",gap:"8px",alignItems:"center"}}>
                    <Badge text={pick.type} color={pick.type==="ML"?"#4a8ab5":pick.type==="RL"?"#e85d04":"#00e5a0"}/>
                    <span style={{fontSize:"14px",fontWeight:900,color:parlay.color,fontFamily:"monospace",minWidth:"52px",textAlign:"right"}}>{pick.odds}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* Player props section */}
          {parlay.picks.filter(p=>!p.isTeam).length>0&&(
            <div style={{marginTop:"8px"}}>
              <div style={{fontSize:"9px",color:"#3a5068",textTransform:"uppercase",letterSpacing:"0.12em",marginBottom:"6px",paddingLeft:"2px"}}>⚡ Props de Jugadores</div>
              {parlay.picks.filter(p=>!p.isTeam).map((pick,i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #0d1e33"}}>
                  <div>
                    <div style={{fontSize:"10px",color:"#3a5068",marginBottom:"2px"}}>{pick.game.replace("@"," @ ")} · {pick.team} · {pick.pos}</div>
                    <div style={{fontSize:"13px",fontWeight:700}}>{pick.player} — {pick.prop}</div>
                    <div style={{fontSize:"10px",color:"#4a6080",marginTop:"1px"}}>{pick.stat}</div>
                  </div>
                  <div style={{display:"flex",gap:"8px",alignItems:"center"}}>
                    <Badge text={pick.type} color={pick.type==="PITCHER"?"#a855f7":"#f59e0b"}/>
                    <span style={{fontSize:"14px",fontWeight:900,color:parlay.color,fontFamily:"monospace",minWidth:"52px",textAlign:"right"}}>{pick.odds}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{marginTop:"12px",padding:"12px",background:"#040d18",borderRadius:"8px",display:"flex",gap:"20px",flexWrap:"wrap"}}>
            <div><span style={{fontSize:"9px",color:"#3a5068"}}>PAGO x$10: </span><span style={{fontSize:"13px",color:"#00e5a0",fontWeight:800}}>${(10*parlay.payoutRaw).toFixed(0)}</span></div>
            <div><span style={{fontSize:"9px",color:"#3a5068"}}>PAGO x$25: </span><span style={{fontSize:"13px",color:"#00e5a0",fontWeight:800}}>${(25*parlay.payoutRaw).toFixed(0)}</span></div>
            <div><span style={{fontSize:"9px",color:"#3a5068"}}>PAGO x$100: </span><span style={{fontSize:"13px",color:"#00e5a0",fontWeight:800}}>${(100*parlay.payoutRaw).toFixed(0)}</span></div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── TRUE NUMBER UI ───────────────────────────────────────────────────────────
const TrueNumberView = ({ data }) => {
  if (!data.length) return <div style={{textAlign:"center",padding:"60px",color:"#3a5068"}}>Sin datos disponibles</div>;
  return (
    <div>
      <div style={{background:"#071320",border:"1px solid #2196f333",borderRadius:"10px",padding:"14px 18px",marginBottom:"18px",display:"flex",gap:"10px",alignItems:"flex-start"}}>
        <span style={{fontSize:"16px"}}>📐</span>
        <div style={{fontSize:"11px",color:"#5a7490",lineHeight:1.7}}>
          <strong style={{color:"#2196f3"}}>True Number: </strong>
          Compara la línea implícita del mercado con el número real calculado por el modelo. <strong style={{color:"#e85d04"}}>TRAMPA</strong> = el mercado está alejado del valor real (edge detectado). <strong style={{color:"#00e5a0"}}>FAIR</strong> = línea alineada con el modelo.
        </div>
      </div>

      {/* Highlighted best pick */}
      {data.filter(d=>d.isBest).length>0 && (
        <div style={{background:"rgba(255,215,0,0.08)",border:"1px solid rgba(255,215,0,0.3)",borderRadius:"12px",padding:"16px 20px",marginBottom:"18px"}}>
          <div style={{fontSize:"10px",color:"#f59e0b",textTransform:"uppercase",letterSpacing:"0.12em",marginBottom:"8px"}}>⭐ Mejor Pick del Día</div>
          <div style={{display:"flex",gap:"24px",flexWrap:"wrap"}}>
            {data.filter(d=>d.isBest).map((d,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:"12px"}}>
                <span style={{fontSize:"16px",fontWeight:900,color:"#f59e0b",fontFamily:"'Barlow Condensed',sans-serif"}}>{d.game}</span>
                <span style={{background:"#f59e0b22",color:"#f59e0b",border:"1px solid #f59e0b44",borderRadius:"6px",padding:"3px 10px",fontSize:"12px",fontWeight:800}}>{d.bestPick}</span>
                <span style={{fontSize:"13px",fontWeight:800,color:"#00e5a0"}}>{d.prob}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Table */}
      <div style={{background:"#071320",border:"1px solid #1a2e45",borderRadius:"12px",overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"1.4fr 0.8fr 0.8fr 0.7fr 0.8fr 0.8fr 0.7fr 1fr 0.6fr",background:"#050f1c",padding:"10px 16px",gap:"8px"}}>
          {["Juego","Spread Mkt","TN Spread","Eval ATS","OU Mkt","OU TN","Eval OU","Recomendación","Prob"].map(h=>(
            <div key={h} style={{fontSize:"9px",color:"#3a5068",textTransform:"uppercase",letterSpacing:"0.1em",textAlign:"center"}}>{h}</div>
          ))}
        </div>
        {data.map((d,i)=>{
          const rowBg = d.isBest ? "rgba(255,215,0,0.07)" : i%2===0 ? "#071320" : "#060e1b";
          const border = d.isBest ? "1px solid rgba(255,215,0,0.2)" : "1px solid transparent";
          return (
            <div key={i} style={{display:"grid",gridTemplateColumns:"1.4fr 0.8fr 0.8fr 0.7fr 0.8fr 0.8fr 0.7fr 1fr 0.6fr",background:rowBg,border,padding:"11px 16px",gap:"8px",alignItems:"center",borderBottom:"1px solid #0d1e33"}}>
              <div style={{fontSize:"13px",fontWeight:800,fontFamily:"'Barlow Condensed',sans-serif"}}>
                {d.isBest && <span style={{marginRight:"4px"}}>⭐</span>}
                <span style={{color:"#00e5a0"}}>{d.away}</span>
                <span style={{color:"#2a3f55",margin:"0 4px"}}>@</span>
                <span style={{color:"#2196f3"}}>{d.home}</span>
                <div style={{fontSize:"9px",color:"#3a5068",marginTop:"1px"}}>{d.time}</div>
              </div>
              <div style={{textAlign:"center",fontSize:"12px",fontWeight:700,color:"#c8dae8"}}>{d.spreadMkt > 0 ? "+" : ""}{d.spreadMkt}</div>
              <div style={{textAlign:"center",fontSize:"12px",fontWeight:700,color:"#f59e0b"}}>{d.tnSpread > 0 ? "+" : ""}{d.tnSpread}</div>
              <div style={{textAlign:"center"}}>
                <span style={{background:d.spreadEval==="TRAMPA"?"rgba(255,80,80,0.2)":"rgba(0,229,160,0.15)",color:d.spreadEval==="TRAMPA"?"#ff6b6b":"#00e5a0",border:`1px solid ${d.spreadEval==="TRAMPA"?"rgba(255,80,80,0.4)":"rgba(0,229,160,0.3)"}`,borderRadius:"20px",padding:"2px 8px",fontSize:"9px",fontWeight:800}}>
                  {d.spreadEval}
                </span>
              </div>
              <div style={{textAlign:"center",fontSize:"12px",fontWeight:700,color:"#c8dae8"}}>{d.ouMkt.toFixed(1)}</div>
              <div style={{textAlign:"center",fontSize:"12px",fontWeight:700,color:"#f59e0b"}}>{d.tnOU.toFixed(1)}</div>
              <div style={{textAlign:"center"}}>
                <span style={{background:d.ouEval==="TRAMPA"?"rgba(255,80,80,0.2)":"rgba(0,229,160,0.15)",color:d.ouEval==="TRAMPA"?"#ff6b6b":"#00e5a0",border:`1px solid ${d.ouEval==="TRAMPA"?"rgba(255,80,80,0.4)":"rgba(0,229,160,0.3)"}`,borderRadius:"20px",padding:"2px 8px",fontSize:"9px",fontWeight:800}}>
                  {d.ouEval}
                </span>
              </div>
              <div style={{textAlign:"center",fontSize:"12px",fontWeight:800,color:"#f59e0b"}}>{d.bestPick}</div>
              <div style={{textAlign:"center",fontSize:"14px",fontWeight:900,color:d.prob>=72?"#00e5a0":d.prob>=62?"#f59e0b":"#8aa8c0"}}>{d.prob}%</div>
            </div>
          );
        })}
      </div>

      <div style={{marginTop:"14px",fontSize:"10px",color:"#3a5068",lineHeight:1.7}}>
        📐 Metodología: TN Spread = diferencial proyectado + ajuste compuesto de modelos M1–M4 · TN OU = total proyectado × factor de tendencia media · Umbral TRAMPA: spread &gt;1.5 carreras, OU &gt;0.8 carreras
      </div>
    </div>
  );
};

// ─── MAXMIN UI ────────────────────────────────────────────────────────────────
const MaxMinView = ({ data }) => {
  if (!data) return <div style={{textAlign:"center",padding:"60px",color:"#3a5068"}}>Sin datos disponibles</div>;
  const { top3Under7, top3Over7, top3team4plus, top3teamSub4 } = data;

  const SectionCard = ({ rank, title, metric, metricVal, sub1, sub2, color }) => (
    <div style={{position:"relative",background:"linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.03))",border:"1px solid #1a2e45",borderRadius:"16px",padding:"16px 16px 16px 56px",marginBottom:"10px"}}>
      <div style={{position:"absolute",left:"14px",top:"16px",width:"30px",height:"30px",borderRadius:"50%",background:`linear-gradient(135deg,${color},${color}99)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:"12px",fontWeight:900,color:"#040d18"}}>{rank}</div>
      <div style={{fontSize:"15px",fontWeight:900,fontFamily:"'Barlow Condensed',sans-serif",color:"#f0f4f8",marginBottom:"4px"}}>{title}</div>
      <div style={{fontSize:"12px",fontWeight:700,color,marginBottom:"4px"}}>{metric}: <strong style={{fontSize:"16px"}}>{metricVal}%</strong></div>
      <div style={{fontSize:"11px",color:"#5a7490"}}>{sub1}</div>
      {sub2 && <div style={{fontSize:"11px",color:"#5a7490"}}>{sub2}</div>}
    </div>
  );

  return (
    <div>
      <div style={{background:"#071320",border:"1px solid #a855f733",borderRadius:"10px",padding:"14px 18px",marginBottom:"18px",display:"flex",gap:"10px",alignItems:"flex-start"}}>
        <span style={{fontSize:"16px"}}>📊</span>
        <div style={{fontSize:"11px",color:"#5a7490",lineHeight:1.7}}>
          <strong style={{color:"#a855f7"}}>MaxMin MLB: </strong>
          Usa distribución de Poisson para calcular probabilidades de scoring por equipo y juego. Identifica los mejores juegos para apostar Under/Over 7 y los equipos más probables de anotar 4+ o menos de 4 carreras.
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:"16px"}}>
        {/* Under 7 */}
        <div style={{background:"#071320",border:"1px solid #1a2e45",borderRadius:"16px",padding:"20px"}}>
          <div style={{fontSize:"13px",fontWeight:800,color:"#2196f3",marginBottom:"4px"}}>🔵 Juegos con mayor prob. de terminar BAJO 7 carreras</div>
          <div style={{fontSize:"10px",color:"#3a5068",marginBottom:"14px"}}>P(total ≤ 6 carreras) vía Poisson con λ = proyección total</div>
          {top3Under7.map((g,i)=>(
            <SectionCard key={i} rank={`#${i+1}`}
              title={g.game} color="#2196f3"
              metric="Prob < 7 carreras" metricVal={g.probUnder7}
              sub1={`Proyección total: ${g.λTotal.toFixed(2)} carreras`}
              sub2={`${g.away}: ${g.projAway} | ${g.home}: ${g.projHome}`}
            />
          ))}
        </div>

        {/* Over 7 */}
        <div style={{background:"#071320",border:"1px solid #1a2e45",borderRadius:"16px",padding:"20px"}}>
          <div style={{fontSize:"13px",fontWeight:800,color:"#e85d04",marginBottom:"4px"}}>🔴 Juegos con mayor prob. de terminar SOBRE 7 carreras</div>
          <div style={{fontSize:"10px",color:"#3a5068",marginBottom:"14px"}}>P(total ≥ 7 carreras) = 1 − Poisson acumulada</div>
          {top3Over7.map((g,i)=>(
            <SectionCard key={i} rank={`#${i+1}`}
              title={g.game} color="#e85d04"
              metric="Prob ≥ 7 carreras" metricVal={g.probOver7}
              sub1={`Proyección total: ${g.λTotal.toFixed(2)} carreras`}
              sub2={`${g.away}: ${g.projAway} | ${g.home}: ${g.projHome}`}
            />
          ))}
        </div>

        {/* 4+ */}
        <div style={{background:"#071320",border:"1px solid #1a2e45",borderRadius:"16px",padding:"20px"}}>
          <div style={{fontSize:"13px",fontWeight:800,color:"#00e5a0",marginBottom:"4px"}}>✅ Equipos con mayor prob. de anotar 4+ carreras</div>
          <div style={{fontSize:"10px",color:"#3a5068",marginBottom:"14px"}}>P(equipo ≥ 4) = 1 − Poisson(3, λ_equipo)</div>
          {top3team4plus.map((g,i)=>(
            <SectionCard key={i} rank={`#${i+1}`}
              title={`${g.game} → ${g.team}`} color="#00e5a0"
              metric="Prob 4+ carreras" metricVal={g.prob}
              sub1={`Rol: ${g.role} | Rival: ${g.rival}`}
              sub2={`Proyección: ${g.proj} carreras`}
            />
          ))}
        </div>

        {/* Sub 4 */}
        <div style={{background:"#071320",border:"1px solid #1a2e45",borderRadius:"16px",padding:"20px"}}>
          <div style={{fontSize:"13px",fontWeight:800,color:"#ff6b6b",marginBottom:"4px"}}>❌ Equipos con mayor prob. de anotar menos de 4 carreras</div>
          <div style={{fontSize:"10px",color:"#3a5068",marginBottom:"14px"}}>P(equipo ≤ 3) = Poisson acumulada hasta k=3</div>
          {top3teamSub4.map((g,i)=>(
            <SectionCard key={i} rank={`#${i+1}`}
              title={`${g.game} → ${g.team}`} color="#ff6b6b"
              metric="Prob < 4 carreras" metricVal={g.prob}
              sub1={`Rol: ${g.role} | Rival: ${g.rival}`}
              sub2={`Proyección: ${g.proj} carreras`}
            />
          ))}
        </div>
      </div>

      <div style={{marginTop:"14px",fontSize:"10px",color:"#3a5068",lineHeight:1.7}}>
        📊 Metodología: Distribución de Poisson con λ = proyección de carreras derivada de OPS+ ofensivo, ERA+ defensivo y factores de parque · Muestra diaria según pitcheo abridor
      </div>
    </div>
  );
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("games");
  const [analyses, setAnalyses] = useState([]);
  const [parlays, setParlays] = useState([]);
  const [trueNumber, setTrueNumber] = useState([]);
  const [maxMin, setMaxMin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openGame, setOpenGame] = useState(null);
  const [dataSource, setDataSource] = useState("live");
  const [lastUpdate, setLastUpdate] = useState(null);

  const todayPT = new Date().toLocaleDateString("es-MX", {weekday:"long",year:"numeric",month:"long",day:"numeric",timeZone:TZ});

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [rawGames, standingsRaw] = await Promise.all([fetchTodayGames(), fetchStandings()]);
      if (!rawGames.length) throw new Error("no_games");
      const winPctMap = {};
      standingsRaw.forEach(div=>(div.teamRecords||[]).forEach(r=>{ winPctMap[r.team.id]=parseFloat(r.winningPercentage)||0.5; }));
      const teamIds=[...new Set(rawGames.flatMap(g=>[g.teams?.home?.team?.id,g.teams?.away?.team?.id]).filter(Boolean))];
      const teamStatsMap={};
      await Promise.allSettled(teamIds.map(async id=>{
        const stats=await fetchTeamStats(id);
        const h=stats.find(s=>s.group?.displayName==="hitting")?.splits?.[0]?.stat||{};
        const p=stats.find(s=>s.group?.displayName==="pitching")?.splits?.[0]?.stat||{};
        teamStatsMap[id]={ops:parseFloat(h.ops)||0.730,era:parseFloat(p.era)||4.00,bullpenEra:parseFloat(p.era)*0.95||3.80,whip:parseFloat(p.whip)||1.25,runDiff:(parseInt(h.runs)||200)-(parseInt(p.runs)||200),parkFactor:100};
      }));
      const result=rawGames.map(g=>analyzeGame(g,winPctMap,teamStatsMap));
      const props=generatePlayerProps(result,teamStatsMap);
      setAnalyses(result);
      setParlays(buildParlays(result,props));
      setTrueNumber(calcTrueNumber(result));
      setMaxMin(calcMaxMin(result));
      setOpenGame(result[0]?.gameId||null);
      setDataSource("live");
    } catch {
      const result=MOCK_GAMES.map(g=>analyzeGame(g,MOCK_WP,MOCK_STATS));
      const props=generatePlayerProps(result,MOCK_STATS);
      setAnalyses(result);
      setParlays(buildParlays(result,props));
      setTrueNumber(calcTrueNumber(result));
      setMaxMin(calcMaxMin(result));
      setOpenGame(result[0]?.gameId||null);
      setDataSource("mock");
    }
    setLastUpdate(new Date().toLocaleTimeString("es-MX",{timeZone:TZ}));
    setLoading(false);
  },[]);

  useEffect(()=>{ loadData(); const iv=setInterval(loadData,60*60*1000); return()=>clearInterval(iv); },[loadData]);

  return (
    <div style={{minHeight:"100vh",background:"#040d18",color:"#c8dae8",fontFamily:"'IBM Plex Mono',monospace"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&family=Barlow+Condensed:wght@700;900&display=swap');
        @keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
        @keyframes spin{to{transform:rotate(360deg)}}
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#040d18}::-webkit-scrollbar-thumb{background:#1a2e45;border-radius:3px}
      `}</style>
      <header style={{background:"#050f1c",borderBottom:"1px solid #1a2e45",padding:"18px 24px 0",position:"sticky",top:0,zIndex:100}}>
        <div style={{maxWidth:"1100px",margin:"0 auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:"12px",marginBottom:"16px"}}>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:"10px"}}>
                <span style={{fontSize:"22px"}}>⚾</span>
                <h1 style={{margin:0,fontSize:"20px",fontWeight:900,fontFamily:"'Barlow Condensed',sans-serif",letterSpacing:"0.1em"}}>
                  MLB <span style={{color:"#00e5a0"}}>ORACLE</span>
                </h1>
                <span style={{background:dataSource==="live"?"#00e5a018":"#f59e0b18",color:dataSource==="live"?"#00e5a0":"#f59e0b",border:`1px solid ${dataSource==="live"?"#00e5a040":"#f59e0b40"}`,borderRadius:"20px",padding:"2px 10px",fontSize:"9px",fontWeight:700,letterSpacing:"0.1em"}}>
                  {dataSource==="live"?"● LIVE":"◉ DEMO"}
                </span>
                <span style={{background:"#2196f318",color:"#2196f3",border:"1px solid #2196f340",borderRadius:"20px",padding:"2px 10px",fontSize:"9px",fontWeight:700,letterSpacing:"0.1em"}}>🕐 HORA PACÍFICO</span>
              </div>
              <div style={{fontSize:"10px",color:"#3a5068",marginTop:"3px",textTransform:"capitalize"}}>{todayPT}</div>
            </div>
            <div style={{display:"flex",gap:"10px",alignItems:"center"}}>
              {lastUpdate&&<span style={{fontSize:"10px",color:"#3a5068"}}>↺ {lastUpdate} PT</span>}
              <button onClick={loadData} disabled={loading} style={{background:loading?"#1a2e45":"#00e5a0",color:loading?"#3a5068":"#040d18",border:"none",borderRadius:"6px",padding:"8px 16px",fontSize:"11px",fontWeight:800,cursor:loading?"not-allowed":"pointer",fontFamily:"inherit"}}>
                {loading?"Cargando...":"↻ Actualizar"}
              </button>
            </div>
          </div>
          <div style={{display:"flex",gap:"0",overflowX:"auto"}}>
            {[
              {id:"games",   label:"⚾ Juegos",         count:analyses.length},
              {id:"parlays", label:"🎯 Parleys + Props", count:parlays.length},
              {id:"truenumber", label:"📐 True Number",  count:trueNumber.length},
              {id:"maxmin",  label:"📊 MaxMin MLB",      count:null},
            ].map(t=>(
              <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"10px 18px",border:"none",background:"transparent",cursor:"pointer",fontSize:"12px",fontWeight:700,fontFamily:"inherit",letterSpacing:"0.06em",whiteSpace:"nowrap",color:tab===t.id?"#f0f4f8":"#3a5068",borderBottom:tab===t.id?"2px solid #00e5a0":"2px solid transparent",transition:"all 0.15s"}}>
                {t.label}{t.count!==null && <span style={{opacity:0.5}}> ({t.count})</span>}
              </button>
            ))}
          </div>
        </div>
      </header>
      <main style={{maxWidth:"1100px",margin:"0 auto",padding:"20px 20px 60px"}}>
        {loading?(
          <div style={{textAlign:"center",padding:"100px 0"}}>
            <div style={{fontSize:"44px",display:"inline-block",animation:"spin 1.2s linear infinite",marginBottom:"16px"}}>⚾</div>
            <div style={{color:"#00e5a0",fontSize:"11px",letterSpacing:"0.15em"}}>CARGANDO MLB ORACLE...</div>
          </div>
        ):(
          <div style={{animation:"fadeUp 0.35s ease"}}>
            {tab==="games"&&(
              <>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:"16px",flexWrap:"wrap",gap:"8px"}}>
                  <span style={{fontSize:"11px",color:"#3a5068",textTransform:"uppercase",letterSpacing:"0.1em"}}>{analyses.length} juegos · click para análisis</span>
                  <span style={{fontSize:"10px",color:"#3a5068"}}>Horarios en Hora del Pacífico (PT)</span>
                </div>
                {analyses.map(g=><GameAnalysis key={g.gameId} analysis={g} isOpen={openGame===g.gameId} onToggle={()=>setOpenGame(openGame===g.gameId?null:g.gameId)}/>)}
              </>
            )}
            {tab==="truenumber"&&(
              <>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:"16px",flexWrap:"wrap",gap:"8px"}}>
                  <span style={{fontSize:"11px",color:"#3a5068",textTransform:"uppercase",letterSpacing:"0.1em"}}>{trueNumber.length} juegos · detección de trampas en líneas</span>
                  <span style={{fontSize:"10px",color:"#3a5068"}}>⭐ = mejor pick del día · ordenado por confianza</span>
                </div>
                <TrueNumberView data={trueNumber}/>
              </>
            )}
            {tab==="maxmin"&&(
              <>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:"16px",flexWrap:"wrap",gap:"8px"}}>
                  <span style={{fontSize:"11px",color:"#3a5068",textTransform:"uppercase",letterSpacing:"0.1em"}}>modelo maxmin · distribución de poisson</span>
                  <span style={{fontSize:"10px",color:"#3a5068"}}>Top 3 por categoría · actualizado cada hora</span>
                </div>
                <MaxMinView data={maxMin}/>
              </>
            )}
            {tab==="parlays"&&(
              <>
                <div style={{background:"#071320",border:"1px solid #f59e0b33",borderRadius:"10px",padding:"14px 18px",marginBottom:"18px",display:"flex",gap:"10px"}}>
                  <span style={{fontSize:"16px"}}>⚠️</span>
                  <div style={{fontSize:"11px",color:"#5a7490",lineHeight:1.7}}>
                    <strong style={{color:"#f59e0b"}}>Aviso: </strong>
                    Parleys generados por modelo estadístico. Cada parley incluye selecciones de equipo + props de jugadores analizados. No garantizan ganancias. Apuesta responsablemente.
                  </div>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:"16px",flexWrap:"wrap",gap:"8px"}}>
                  <span style={{fontSize:"11px",color:"#3a5068",textTransform:"uppercase",letterSpacing:"0.1em"}}>{parlays.length} parleys · equipos + props combinados</span>
                  <span style={{fontSize:"10px",color:"#3a5068"}}>ML · RL · O/U · K+ · Hits · Bases · CI+Carr</span>
                </div>
                {parlays.length===0
                  ?<div style={{textAlign:"center",padding:"80px",color:"#3a5068"}}>🎯 Se necesitan más juegos para generar parleys</div>
                  :parlays.map((p,i)=><ParlayCard key={p.id} parlay={p} index={i}/>)
                }
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
