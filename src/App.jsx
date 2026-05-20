import { useState, useEffect, useCallback } from "react";

// ─── MLB API via Vercel proxy (evita CORS) ────────────────────────────────────
const API = "/mlb-api";

const fetchTodayGames = async () => {
  const today = new Date().toISOString().split("T")[0];
  const url = `${API}/schedule?sportId=1&date=${today}&hydrate=team,linescore,probablePitcher,person,venue`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("API error");
  const data = await res.json();
  const dates = data.dates || [];
  if (!dates.length) return [];
  return dates[0].games || [];
};

const fetchStandings = async () => {
  const season = new Date().getFullYear();
  const url = `${API}/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("standings error");
  const data = await res.json();
  return data.records || [];
};

// ─── SABERMETRIC ENGINE ───────────────────────────────────────────────────────
const log5 = (pA, pB) => {
  const n = pA - pA * pB;
  const d = pA + pB - 2 * pA * pB;
  if (d === 0) return 0.5;
  return Math.min(0.93, Math.max(0.07, n / d));
};

const calcWinProb = (homeWinPct, awayWinPct) => {
  const hAdj = Math.min(0.94, (homeWinPct || 0.5) * 1.04);
  const aAdj = Math.min(0.94, (awayWinPct || 0.5) * 0.96);
  return log5(hAdj, aAdj);
};

const probToAmerican = (p) => {
  if (p <= 0 || p >= 1) return "N/A";
  if (p >= 0.5) return `-${Math.round((p / (1 - p)) * 100)}`;
  return `+${Math.round(((1 - p) / p) * 100)}`;
};

const probToDecimal = (p) => {
  if (p <= 0) return 1;
  return 1 / p;
};

// ─── PARLAY BUILDER ───────────────────────────────────────────────────────────
const buildParlays = (predictions, count = 10, size = 10) => {
  if (predictions.length < 3) return [];

  const pool = [];
  predictions.forEach((g) => {
    const hProb = g.homeWin / 100;
    const aProb = g.awayWin / 100;
    const ou = g.projHome + g.projAway;
    const overProb = hProb > 0.55 ? 0.54 : 0.48;

    pool.push({ game: `${g.away} @ ${g.home}`, pick: g.home, type: "ML", prob: hProb, odds: probToAmerican(hProb), confidence: g.confidence });
    pool.push({ game: `${g.away} @ ${g.home}`, pick: g.away, type: "ML", prob: aProb, odds: probToAmerican(aProb), confidence: 100 - g.confidence });
    pool.push({ game: `${g.away} @ ${g.home}`, pick: `OVER ${ou.toFixed(1)}`, type: "O/U", prob: overProb, odds: probToAmerican(overProb), confidence: Math.round(overProb * 100) });
    pool.push({ game: `${g.away} @ ${g.home}`, pick: `UNDER ${ou.toFixed(1)}`, type: "O/U", prob: 1 - overProb, odds: probToAmerican(1 - overProb), confidence: Math.round((1 - overProb) * 100) });
    if (hProb > 0.60) pool.push({ game: `${g.away} @ ${g.home}`, pick: `${g.home} -1.5`, type: "RL", prob: hProb * 0.72, odds: probToAmerican(hProb * 0.72), confidence: Math.round(hProb * 72) });
    if (aProb > 0.60) pool.push({ game: `${g.away} @ ${g.home}`, pick: `${g.away} -1.5`, type: "RL", prob: aProb * 0.72, odds: probToAmerican(aProb * 0.72), confidence: Math.round(aProb * 72) });
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

  const colors = ["#e85d04","#f59e0b","#38c172","#4a8ab5","#a855f7","#ec4899","#06b6d4","#84cc16","#f97316","#6366f1"];

  return strategies.slice(0, count).map((strat, i) => {
    const filtered = pool.filter(strat.filter).sort(strat.sort);
    const seen = new Set();
    const picks = [];
    for (const s of filtered) {
      if (!seen.has(s.game) && picks.length < size) {
        seen.add(s.game);
        picks.push(s);
      }
    }
    // Fill remaining from full pool if not enough unique games
    if (picks.length < size) {
      for (const s of pool.sort(() => Math.random() - 0.5)) {
        if (!picks.find((p) => p === s) && picks.length < size) picks.push(s);
      }
    }

    const usedPicks = picks.slice(0, Math.min(size, picks.length));
    const combinedProb = usedPicks.reduce((acc, p) => acc * p.prob, 1);
    const decimalPayout = usedPicks.reduce((acc, p) => acc * probToDecimal(p.prob), 1);

    return {
      id: i + 1,
      name: strat.name,
      picks: usedPicks,
      combinedProb: (combinedProb * 100).toFixed(3),
      payout: `${Math.round(decimalPayout)}x`,
      payoutRaw: decimalPayout,
      color: colors[i],
    };
  });
};

// ─── MOCK DATA FALLBACK ───────────────────────────────────────────────────────
const generateMockGames = () => {
  const matchups = [
    { home: "Yankees", away: "Red Sox", hWp: 0.58, aWp: 0.51, venue: "Yankee Stadium", time: "7:05 PM ET" },
    { home: "Dodgers", away: "Padres", hWp: 0.62, aWp: 0.54, venue: "Dodger Stadium", time: "10:10 PM ET" },
    { home: "Astros", away: "Mariners", hWp: 0.55, aWp: 0.52, venue: "Minute Maid Park", time: "8:10 PM ET" },
    { home: "Braves", away: "Phillies", hWp: 0.57, aWp: 0.55, venue: "Truist Park", time: "7:20 PM ET" },
    { home: "Rays", away: "Blue Jays", hWp: 0.53, aWp: 0.52, venue: "Tropicana Field", time: "6:50 PM ET" },
    { home: "Cubs", away: "Cardinals", hWp: 0.50, aWp: 0.51, venue: "Wrigley Field", time: "7:40 PM ET" },
    { home: "Giants", away: "Rockies", hWp: 0.52, aWp: 0.43, venue: "Oracle Park", time: "9:45 PM ET" },
    { home: "Twins", away: "White Sox", hWp: 0.54, aWp: 0.44, venue: "Target Field", time: "7:40 PM ET" },
    { home: "Mets", away: "Marlins", hWp: 0.53, aWp: 0.46, venue: "Citi Field", time: "7:10 PM ET" },
    { home: "Rangers", away: "Angels", hWp: 0.56, aWp: 0.47, venue: "Globe Life Field", time: "8:05 PM ET" },
    { home: "Orioles", away: "Tigers", hWp: 0.58, aWp: 0.48, venue: "Camden Yards", time: "7:05 PM ET" },
    { home: "Guardians", away: "Royals", hWp: 0.55, aWp: 0.49, venue: "Progressive Field", time: "6:40 PM ET" },
    { home: "Brewers", away: "Pirates", hWp: 0.54, aWp: 0.46, venue: "American Family Field", time: "8:10 PM ET" },
    { home: "Diamondbacks", away: "Reds", hWp: 0.51, aWp: 0.50, venue: "Chase Field", time: "9:40 PM ET" },
    { home: "Nationals", away: "Marlins", hWp: 0.47, aWp: 0.46, venue: "Nationals Park", time: "7:05 PM ET" },
  ];
  const pitchers = ["G. Cole", "C. Burnes", "S. Alcantara", "Z. Wheeler", "L. Gilbert", "P. López", "M. Soroka", "J. Flaherty", "F. Valdez", "K. Gausman", "D. Eflin", "B. Snell"];
  return matchups.map((m, i) => {
    const homeWin = calcWinProb(m.hWp, m.aWp);
    const confidence = Math.round(50 + Math.abs(homeWin - 0.5) * 80);
    return {
      id: i + 1,
      home: m.home, away: m.away, venue: m.venue, time: m.time,
      homeWin: Math.round(homeWin * 100),
      awayWin: Math.round((1 - homeWin) * 100),
      projHome: +(4.2 + (m.hWp - 0.5) * 4).toFixed(1),
      projAway: +(4.0 + (m.aWp - 0.5) * 4).toFixed(1),
      confidence,
      homePitcher: pitchers[i % pitchers.length],
      awayPitcher: pitchers[(i + 4) % pitchers.length],
    };
  });
};

// ─── UI COMPONENTS ────────────────────────────────────────────────────────────
const Badge = ({ text, color }) => (
  <span style={{ background: `${color}22`, color, border: `1px solid ${color}44`, borderRadius: "4px", padding: "2px 7px", fontSize: "10px", fontWeight: 700, letterSpacing: "0.06em" }}>{text}</span>
);

const GameCard = ({ game }) => (
  <div style={{ background: "#0a1628", border: "1px solid #1e3a5f", borderRadius: "12px", padding: "18px", marginBottom: "10px", transition: "border-color 0.2s" }}
    onMouseEnter={e => e.currentTarget.style.borderColor = "#4a8ab555"}
    onMouseLeave={e => e.currentTarget.style.borderColor = "#1e3a5f"}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px", flexWrap: "wrap", gap: "8px" }}>
      <div>
        <div style={{ fontSize: "15px", fontWeight: 900, fontFamily: "'Barlow Condensed', monospace", letterSpacing: "0.04em" }}>
          <span style={{ color: "#4a8ab5" }}>{game.home}</span>
          <span style={{ color: "#2a3f5f", margin: "0 8px" }}>VS</span>
          <span style={{ color: "#e85d04" }}>{game.away}</span>
        </div>
        <div style={{ fontSize: "10px", color: "#4a6080", marginTop: "3px" }}>{game.time} · {game.venue}</div>
      </div>
      <Badge text={`Conf. ${game.confidence}%`} color={game.confidence >= 65 ? "#38c172" : "#f59e0b"} />
    </div>

    {/* Win bar */}
    <div style={{ marginBottom: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
        <span style={{ fontSize: "11px", color: "#4a8ab5", fontWeight: 700 }}>{game.home} {game.homeWin}%</span>
        <span style={{ fontSize: "11px", color: "#e85d04", fontWeight: 700 }}>{game.awayWin}% {game.away}</span>
      </div>
      <div style={{ height: "6px", background: "#1a2540", borderRadius: "3px", overflow: "hidden", display: "flex" }}>
        <div style={{ width: `${game.homeWin}%`, background: "linear-gradient(90deg,#2563eb,#60a5fa)", transition: "width 0.6s" }} />
        <div style={{ width: `${game.awayWin}%`, background: "linear-gradient(90deg,#f97316,#e85d04)", transition: "width 0.6s" }} />
      </div>
    </div>

    {/* Stats row */}
    <div style={{ display: "flex", gap: "20px", flexWrap: "wrap" }}>
      {[
        { label: "Marcador Est.", value: `${game.projHome}–${game.projAway}`, color: "#f0f4f8" },
        { label: "O/U", value: (game.projHome + game.projAway).toFixed(1), color: "#38c172" },
        { label: "ML Local", value: probToAmerican(game.homeWin / 100), color: "#4a8ab5" },
        { label: "ML Visit.", value: probToAmerican(game.awayWin / 100), color: "#e85d04" },
        game.homePitcher && { label: "P. Local", value: game.homePitcher, color: "#a855f7" },
        game.awayPitcher && { label: "P. Visit.", value: game.awayPitcher, color: "#f59e0b" },
      ].filter(Boolean).map((s) => (
        <div key={s.label} style={{ textAlign: "center" }}>
          <div style={{ fontSize: "9px", color: "#4a6080", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "2px" }}>{s.label}</div>
          <div style={{ fontSize: "13px", fontWeight: 800, color: s.color }}>{s.value}</div>
        </div>
      ))}
    </div>
  </div>
);

const ParlayCard = ({ parlay, index }) => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: "#0a1628", border: `1px solid ${parlay.color}33`, borderRadius: "12px", marginBottom: "10px", overflow: "hidden" }}>
      <div onClick={() => setOpen((o) => !o)} style={{ padding: "16px 18px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: "32px", height: "32px", borderRadius: "50%", background: `${parlay.color}20`, border: `2px solid ${parlay.color}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px", fontWeight: 900, color: parlay.color, flexShrink: 0 }}>
            {index + 1}
          </div>
          <div>
            <div style={{ fontSize: "13px", fontWeight: 800 }}>{parlay.name}</div>
            <div style={{ fontSize: "10px", color: "#4a6080" }}>{parlay.picks.length} selecciones</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: "9px", color: "#4a6080", textTransform: "uppercase" }}>Prob. combinada</div>
            <div style={{ fontSize: "14px", fontWeight: 900, color: parlay.color }}>{parlay.combinedProb}%</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: "9px", color: "#4a6080", textTransform: "uppercase" }}>Pago potencial</div>
            <div style={{ fontSize: "14px", fontWeight: 900, color: "#38c172" }}>{parlay.payout}</div>
          </div>
          <span style={{ color: "#4a6080", fontSize: "14px", transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "none", display: "inline-block" }}>▼</span>
        </div>
      </div>

      {open && (
        <div style={{ borderTop: `1px solid ${parlay.color}22`, padding: "4px 18px 16px" }}>
          {parlay.picks.map((pick, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: i < parlay.picks.length - 1 ? "1px solid #131f33" : "none" }}>
              <div>
                <div style={{ fontSize: "10px", color: "#4a6080", marginBottom: "2px" }}>{pick.game}</div>
                <div style={{ fontSize: "13px", fontWeight: 700 }}>{pick.pick}</div>
              </div>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <Badge text={pick.type} color={pick.type === "ML" ? "#4a8ab5" : pick.type === "RL" ? "#e85d04" : "#38c172"} />
                <span style={{ fontSize: "14px", fontWeight: 900, color: parlay.color, fontFamily: "monospace", minWidth: "52px", textAlign: "right" }}>{pick.odds}</span>
              </div>
            </div>
          ))}
          <div style={{ marginTop: "12px", padding: "12px", background: "#060e1c", borderRadius: "8px", display: "flex", gap: "24px", flexWrap: "wrap" }}>
            <div><span style={{ fontSize: "9px", color: "#4a6080", textTransform: "uppercase" }}>PAGO x$10 </span><span style={{ fontSize: "13px", color: "#38c172", fontWeight: 800 }}>${(10 * parlay.payoutRaw).toFixed(0)}</span></div>
            <div><span style={{ fontSize: "9px", color: "#4a6080", textTransform: "uppercase" }}>PAGO x$25 </span><span style={{ fontSize: "13px", color: "#38c172", fontWeight: 800 }}>${(25 * parlay.payoutRaw).toFixed(0)}</span></div>
            <div><span style={{ fontSize: "9px", color: "#4a6080", textTransform: "uppercase" }}>PAGO x$100 </span><span style={{ fontSize: "13px", color: "#38c172", fontWeight: 800 }}>${(100 * parlay.payoutRaw).toFixed(0)}</span></div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("games");
  const [games, setGames] = useState([]);
  const [parlays, setParlays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dataSource, setDataSource] = useState("live");
  const [lastUpdate, setLastUpdate] = useState(null);
  const [gameCount, setGameCount] = useState(0);

  const today = new Date().toLocaleDateString("es-MX", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [rawGames, standingsRaw] = await Promise.all([fetchTodayGames(), fetchStandings()]);

      if (!rawGames.length) throw new Error("no_games");

      const winPctMap = {};
      standingsRaw.forEach((div) => {
        (div.teamRecords || []).forEach((r) => {
          winPctMap[r.team.id] = parseFloat(r.winningPercentage) || 0.5;
        });
      });

      const predictions = rawGames.map((g, i) => {
        const homeId = g.teams?.home?.team?.id;
        const awayId = g.teams?.away?.team?.id;
        const homeName = g.teams?.home?.team?.teamName || g.teams?.home?.team?.name || "Local";
        const awayName = g.teams?.away?.team?.teamName || g.teams?.away?.team?.name || "Visitante";
        const hWp = winPctMap[homeId] || 0.5;
        const aWp = winPctMap[awayId] || 0.5;
        const homeWin = calcWinProb(hWp, aWp);
        const confidence = Math.round(50 + Math.abs(homeWin - 0.5) * 80);
        const gameTime = g.gameDate
          ? new Date(g.gameDate).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }) + " ET"
          : "TBD";

        return {
          id: i + 1,
          home: homeName, away: awayName,
          venue: g.venue?.name || "",
          time: gameTime,
          homeWin: Math.round(homeWin * 100),
          awayWin: Math.round((1 - homeWin) * 100),
          projHome: +(4.2 * (hWp / 0.5)).toFixed(1),
          projAway: +(4.2 * (aWp / 0.5)).toFixed(1),
          confidence,
          homePitcher: g.teams?.home?.probablePitcher?.lastName || null,
          awayPitcher: g.teams?.away?.probablePitcher?.lastName || null,
        };
      });

      setGames(predictions);
      setGameCount(predictions.length);
      setParlays(buildParlays(predictions, 10, 10));
      setDataSource("live");
    } catch (err) {
      const mock = generateMockGames();
      setGames(mock);
      setGameCount(mock.length);
      setParlays(buildParlays(mock, 10, 10));
      setDataSource(err.message === "no_games" ? "no_games" : "mock");
    }
    setLastUpdate(new Date().toLocaleTimeString("es-MX"));
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    const iv = setInterval(loadData, 60 * 60 * 1000);
    return () => clearInterval(iv);
  }, [loadData]);

  const statusColor = dataSource === "live" ? "#38c172" : "#f59e0b";
  const statusLabel = dataSource === "live" ? "● LIVE MLB API" : dataSource === "no_games" ? "◉ SIN JUEGOS HOY" : "◉ DEMO MODE";

  return (
    <div style={{ minHeight: "100vh", background: "#060e1c" }}>
      {/* Header */}
      <header style={{ background: "#08111f", borderBottom: "1px solid #1e3a5f", padding: "20px 24px 0", position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(12px)" }}>
        <div style={{ maxWidth: "960px", margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{ fontSize: "24px" }}>⚾</span>
                <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 900, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: "0.08em" }}>
                  MLB <span style={{ color: "#e85d04" }}>ORACLE</span>
                </h1>
                <span style={{ background: `${statusColor}18`, color: statusColor, border: `1px solid ${statusColor}40`, borderRadius: "20px", padding: "2px 10px", fontSize: "9px", fontWeight: 700, letterSpacing: "0.1em" }}>
                  {statusLabel}
                </span>
              </div>
              <div style={{ fontSize: "10px", color: "#4a6080", marginTop: "4px", textTransform: "capitalize" }}>{today}</div>
            </div>
            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              {lastUpdate && <span style={{ fontSize: "10px", color: "#4a6080" }}>Actualizado: {lastUpdate}</span>}
              <button onClick={loadData} disabled={loading} style={{
                background: loading ? "#1a2540" : "#e85d04", color: loading ? "#4a6080" : "#000",
                border: "none", borderRadius: "8px", padding: "9px 18px", fontSize: "11px",
                fontWeight: 800, cursor: loading ? "not-allowed" : "pointer", letterSpacing: "0.08em",
                fontFamily: "inherit", transition: "all 0.2s",
              }}>
                {loading ? "⟳ Cargando..." : "↻ Actualizar"}
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: "0" }}>
            {[
              { id: "games", label: "⚾ Juegos del Día", count: gameCount },
              { id: "parlays", label: "🎯 Parleys (10x10)", count: parlays.length },
            ].map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                padding: "10px 22px", border: "none", background: "transparent", cursor: "pointer",
                fontSize: "12px", fontWeight: 700, fontFamily: "inherit", letterSpacing: "0.06em",
                color: tab === t.id ? "#f0f4f8" : "#4a6080",
                borderBottom: tab === t.id ? "2px solid #e85d04" : "2px solid transparent",
                transition: "all 0.15s",
              }}>
                {t.label} <span style={{ opacity: 0.5 }}>({t.count})</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Content */}
      <main style={{ maxWidth: "960px", margin: "0 auto", padding: "24px 20px 60px" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: "100px 0" }}>
            <div style={{ fontSize: "48px", marginBottom: "20px", display: "inline-block", animation: "spin 1.2s linear infinite" }}>⚾</div>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes up{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}`}</style>
            <div style={{ color: "#4a8ab5", fontSize: "12px", letterSpacing: "0.15em" }}>CONECTANDO MLB STATS API...</div>
          </div>
        ) : (
          <div style={{ animation: "up 0.35s ease" }}>
            <style>{`@keyframes up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}`}</style>

            {tab === "games" && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "18px", alignItems: "center" }}>
                  <span style={{ fontSize: "11px", color: "#4a6080", textTransform: "uppercase", letterSpacing: "0.1em" }}>{games.length} juegos · {new Date().toLocaleDateString("es-MX")}</span>
                  <span style={{ fontSize: "10px", color: "#4a6080" }}>Pitagórico · Log5 · Win% real</span>
                </div>
                {games.length === 0
                  ? <div style={{ textAlign: "center", padding: "80px", color: "#4a6080" }}>🏟️ No hay juegos hoy</div>
                  : games.map((g) => <GameCard key={g.id} game={g} />)
                }
              </>
            )}

            {tab === "parlays" && (
              <>
                <div style={{ background: "#0a1628", border: "1px solid #f59e0b33", borderRadius: "10px", padding: "14px 18px", marginBottom: "18px", display: "flex", gap: "10px" }}>
                  <span style={{ fontSize: "16px" }}>⚠️</span>
                  <div style={{ fontSize: "11px", color: "#8a9bb0", lineHeight: 1.7 }}>
                    <strong style={{ color: "#f59e0b" }}>Aviso: </strong>
                    Estos parleys son generados por un modelo estadístico y no garantizan ganancias. Las apuestas deportivas conllevan riesgo de pérdida. Apuesta con responsabilidad.
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "18px", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                  <span style={{ fontSize: "11px", color: "#4a6080", textTransform: "uppercase", letterSpacing: "0.1em" }}>10 parleys · 10 selecciones c/u</span>
                  <span style={{ fontSize: "10px", color: "#4a6080" }}>ML · Run Lines · Over/Under</span>
                </div>
                {parlays.length === 0
                  ? <div style={{ textAlign: "center", padding: "80px", color: "#4a6080" }}>🎯 Se necesitan más juegos para generar parleys ({games.length} disponibles)</div>
                  : parlays.map((p, i) => <ParlayCard key={p.id} parlay={p} index={i} />)
                }
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
