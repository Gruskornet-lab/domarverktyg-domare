import { useState, useCallback, useRef } from "react";

const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const createRider = (id, name = "") => ({ id, name, clear: null });
const createTeam = (id, name = "", riderNames = []) => {
  const riders = riderNames.length > 0
    ? riderNames.map((n, i) => createRider(i + 1, n))
    : [createRider(1), createRider(2), createRider(3)];
  return { id, name: name || `Lag ${id}`, riders, nextRiderId: riders.length + 1 };
};

/* ─── Club detection ─── */
const CLUB_WORDS = /ridklubb|ridsportklubb|ridsportförening|ryttarförening|hästsportklubb|hoppryttare|rid-\s*och|ridförening/i;
function isClubName(t) { return CLUB_WORDS.test(t.trim()); }
function normalizeClub(t) { return t.trim().replace(/\s+/g, " "); }

/* ─── Equipe parser ─── */
function parseEquipeText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d{1,3})\s+([A-ZÅÄÖ][a-zåäöé]+(?:\s+[A-ZÅÄÖ][a-zåäöé\-]+)+)\s*$/);
    if (!m) continue;
    const rider = m[2].trim();
    let club = "";
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const c = lines[j].trim();
      if (isClubName(c)) { club = normalizeClub(c); break; }
      if (j + 1 < lines.length && isClubName(c + " " + lines[j + 1].trim())) {
        club = normalizeClub(c + " " + lines[j + 1].trim()); break;
      }
    }
    if (club) entries.push({ rider, club });
  }
  if (entries.length === 0) return [];
  const map = new Map();
  for (const e of entries) { if (!map.has(e.club)) map.set(e.club, []); map.get(e.club).push(e.rider); }
  return Array.from(map.entries()).map(([club, riders]) => ({ name: club, riders }));
}

/* ─── Simple text parser ─── */
function parseSimpleText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const teams = []; let cur = null;
  for (const line of lines) {
    const isHeader = /^lag\s/i.test(line) || /^team\s/i.test(line) || line.endsWith(":") || (/^[A-ZÅÄÖ\s&\-]+$/.test(line) && line.length > 2);
    if (isHeader) { if (cur?.riders.length) teams.push(cur); cur = { name: line.replace(/:$/, "").trim(), riders: [] }; }
    else { if (!cur) cur = { name: "Lag 1", riders: [] }; const c = line.replace(/^\d+[\.\)]\s*/, "").replace(/^[-•]\s*/, "").trim(); if (c) cur.riders.push(c); }
  }
  if (cur?.riders.length) teams.push(cur);
  return teams;
}

function parseTeamText(text) {
  if (/st\.?nr|startlista|equipe|kategori\s+[a-d]/i.test(text)) { const r = parseEquipeText(text); if (r.length) return r; }
  return parseSimpleText(text);
}

/* ─── PDF ─── */
function loadPdfJs() {
  return new Promise((res, rej) => {
    if (window.pdfjsLib) { res(window.pdfjsLib); return; }
    const s = document.createElement("script"); s.src = PDFJS_CDN;
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; res(window.pdfjsLib); };
    s.onerror = () => rej(new Error("PDF-bibliotek ej tillgängligt")); document.head.appendChild(s);
  });
}
async function extractPdfText(file) {
  const lib = await loadPdfJs(); const buf = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: buf }).promise; let t = "";
  for (let i = 1; i <= pdf.numPages; i++) { const p = await pdf.getPage(i); const c = await p.getTextContent(); t += c.items.map(x => x.str).join("\n") + "\n"; }
  return t;
}

/* ─── Stats helper ─── */
function getStats(team) {
  const total = team.riders.length;
  const ridden = team.riders.filter(r => r.clear !== null).length;
  const clearCount = team.riders.filter(r => r.clear === true).length;
  const allDone = ridden === total;
  const qualified = clearCount >= 3;
  const percent = qualified ? Math.round((clearCount / total) * 100) : null;
  return { total, ridden, clearCount, allDone, qualified, percent };
}

/* ═══════════════════════════════════════════
   MAIN
   ═══════════════════════════════════════════ */
export default function DomarVerktyg() {
  const [teams, setTeams] = useState([createTeam(1), createTeam(2)]);
  const [nextId, setNextId] = useState(3);
  const [phase, setPhase] = useState("setup"); // setup | deltavling | mellanresultat | final | slutresultat
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importStatus, setImportStatus] = useState(null);
  const [importing, setImporting] = useState(false);
  const [finalTeams, setFinalTeams] = useState([]);
  const fileRef = useRef(null);

  /* ─── Team/rider CRUD ─── */
  const updateTeams = (fn) => { setTeams(fn); };
  const addTeam = () => { updateTeams(t => [...t, createTeam(nextId)]); setNextId(n => n + 1); };
  const removeTeam = (id) => updateTeams(t => t.filter(x => x.id !== id));
  const updateTeamName = (id, name) => updateTeams(t => t.map(x => x.id === id ? { ...x, name } : x));
  const addRider = (teamId) => updateTeams(t => t.map(x => {
    if (x.id !== teamId || x.riders.length >= 8) return x;
    return { ...x, riders: [...x.riders, createRider(x.nextRiderId)], nextRiderId: x.nextRiderId + 1 };
  }));
  const removeRider = (teamId, riderId) => updateTeams(t => t.map(x => {
    if (x.id !== teamId || x.riders.length <= 3) return x;
    return { ...x, riders: x.riders.filter(r => r.id !== riderId) };
  }));
  const updateRider = (teamId, riderId, field, value) => updateTeams(t => t.map(x => {
    if (x.id !== teamId) return x;
    return { ...x, riders: x.riders.map(r => r.id === riderId ? { ...r, [field]: value } : r) };
  }));

  /* same CRUD but for finalTeams */
  const updateFinalRider = (teamId, riderId, field, value) => {
    setFinalTeams(t => t.map(x => {
      if (x.id !== teamId) return x;
      return { ...x, riders: x.riders.map(r => r.id === riderId ? { ...r, [field]: value } : r) };
    }));
  };

  /* ─── Import ─── */
  const handleFile = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    setImporting(true); setImportStatus(null);
    try {
      const text = file.name.endsWith(".pdf") ? await extractPdfText(file) : await file.text();
      setImportText(text);
      const p = parseTeamText(text);
      setImportStatus({ type: "success", msg: `${file.name} — ${p.length} lag, ${p.reduce((s, t) => s + t.riders.length, 0)} ryttare` });
    } catch (err) { setImportStatus({ type: "error", msg: err.message }); }
    setImporting(false); if (fileRef.current) fileRef.current.value = "";
  };
  const applyImport = () => {
    const p = parseTeamText(importText);
    if (!p.length) { setImportStatus({ type: "error", msg: "Inga lag hittades." }); return; }
    const newTeams = p.map((t, i) => createTeam(nextId + i, t.name, t.riders.slice(0, 8)));
    setTeams(newTeams); setNextId(nextId + p.length);
    setShowImport(false); setImportText(""); setImportStatus(null);
  };

  /* ─── Phase transitions ─── */
  const startDeltavling = () => setPhase("deltavling");

  const finishDeltavling = () => setPhase("mellanresultat");

  const startFinal = () => {
    // Create final teams from qualified teams, reset rider results
    const qualified = teams.filter(t => getStats(t).qualified);
    const ft = qualified.map(t => ({
      ...t,
      riders: t.riders.map(r => ({ ...r, clear: null })),
    }));
    setFinalTeams(ft);
    setPhase("final");
  };

  const finishFinal = () => setPhase("slutresultat");

  const resetAll = () => {
    setTeams([createTeam(1), createTeam(2)]); setNextId(3);
    setFinalTeams([]); setPhase("setup");
    setShowImport(false); setImportText(""); setImportStatus(null);
  };

  /* ─── Ranking ─── */
  const rankTeams = (teamList) => {
    const scored = teamList.map(t => ({ ...t, ...getStats(t) }));
    scored.sort((a, b) => {
      if (a.percent === null && b.percent === null) return 0;
      if (a.percent === null) return 1; if (b.percent === null) return -1;
      return b.percent - a.percent;
    });
    let rank = 0, last = null;
    return scored.map((t, i) => {
      if (t.percent !== null) { if (t.percent !== last) { rank = i + 1; last = t.percent; } return { ...t, rank }; }
      return { ...t, rank: "-" };
    });
  };

  const previewData = importText.trim() ? parseTeamText(importText) : [];
  const qualifiedCount = teams.filter(t => getStats(t).qualified).length;
  const notQualifiedCount = teams.filter(t => getStats(t).allDone && !getStats(t).qualified).length;

  /* ─── Phase badge ─── */
  const phaseLabel = { setup: "Förberedelse", deltavling: "Deltävling", mellanresultat: "Kvalresultat", final: "Final", slutresultat: "Slutresultat" };
  const phaseColor = { setup: "#64748b", deltavling: "#38bdf8", mellanresultat: "#f59e0b", final: "#a78bfa", slutresultat: "#34d399" };

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(145deg, #0a1628 0%, #132744 50%, #1a3356 100%)", fontFamily: "'Helvetica Neue', 'Segoe UI', sans-serif", color: "#e8edf4", padding: 0, position: "relative" }}>
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundImage: "radial-gradient(circle at 20% 80%, rgba(56,189,248,0.04) 0%, transparent 50%), radial-gradient(circle at 80% 20%, rgba(251,191,36,0.04) 0%, transparent 50%)", pointerEvents: "none", zIndex: 0 }} />

      <div style={{ position: "relative", zIndex: 1, maxWidth: 700, margin: "0 auto", padding: "24px 16px 80px" }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10, background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.25)", borderRadius: 40, padding: "6px 18px", marginBottom: 12, fontSize: 11, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", color: "#fbbf24" }}>
            <span style={{ fontSize: 16 }}>🐴</span> Hoppallsvenskan Div 3
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 4px", background: "linear-gradient(135deg, #f1f5f9 0%, #94a3b8 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Domarverktyg</h1>

          {/* Phase indicator */}
          <div style={{ display: "flex", justifyContent: "center", gap: 4, marginTop: 14 }}>
            {["setup", "deltavling", "mellanresultat", "final", "slutresultat"].map((p, i) => (
              <div key={p} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{
                  width: phase === p ? "auto" : 10, height: 10, minWidth: 10,
                  borderRadius: 20, transition: "all 0.3s",
                  padding: phase === p ? "3px 12px" : 0,
                  background: phase === p ? phaseColor[p] : i <= ["setup", "deltavling", "mellanresultat", "final", "slutresultat"].indexOf(phase) ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.06)",
                  fontSize: 10, fontWeight: 800, color: "#0a1628",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  letterSpacing: 0.5,
                }}>
                  {phase === p ? phaseLabel[p].toUpperCase() : ""}
                </div>
                {i < 4 && <div style={{ width: 16, height: 1, background: "rgba(255,255,255,0.1)" }} />}
              </div>
            ))}
          </div>
        </div>

        {/* ═══ SETUP PHASE ═══ */}
        {phase === "setup" && (
          <>
            {/* Import */}
            <button onClick={() => setShowImport(!showImport)}
              style={{ width: "100%", padding: "14px", marginBottom: 16, background: showImport ? "rgba(56,189,248,0.15)" : "rgba(56,189,248,0.08)", border: `1px solid ${showImport ? "rgba(56,189,248,0.3)" : "rgba(56,189,248,0.15)"}`, borderRadius: 14, color: "#38bdf8", fontSize: 14, fontWeight: 700, cursor: "pointer", transition: "all 0.2s", display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="12" y2="12"/><line x1="15" y1="15" x2="12" y2="12"/></svg>
              {showImport ? "Stäng import" : "Importera startlista (Equipe PDF / text)"}
            </button>

            {showImport && <ImportPanel {...{ importText, setImportText, importStatus, setImportStatus, importing, fileRef, handleFile, applyImport, previewData }} />}

            {/* Teams */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {teams.map(team => <TeamCard key={team.id} team={team} stats={getStats(team)} phase="setup" onUpdateName={updateTeamName} onRemoveTeam={removeTeam} onAddRider={addRider} onRemoveRider={removeRider} onUpdateRider={updateRider} canRemoveTeam={teams.length > 2} />)}
            </div>
            <button onClick={addTeam} style={addBtnStyle} onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; e.currentTarget.style.color = "#94a3b8"; }} onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.color = "#64748b"; }}>
              <span style={{ fontSize: 20, lineHeight: 1 }}>+</span> Lägg till lag
            </button>

            <button onClick={startDeltavling} style={{ ...calcBtnStyle, width: "100%", marginTop: 20, background: "linear-gradient(135deg, #38bdf8 0%, #0ea5e9 100%)", boxShadow: "0 4px 20px rgba(56,189,248,0.3)" }}>
              Starta deltävling →
            </button>
          </>
        )}

        {/* ═══ DELTÄVLING PHASE ═══ */}
        {phase === "deltavling" && (
          <>
            <InfoBox color="#38bdf8" title="Deltävling" text="Markera varje ryttares resultat. Lag med minst 3 felfria kvalificerar sig till finalen." />

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {teams.map(team => {
                const s = getStats(team);
                return <TeamCard key={team.id} team={team} stats={s} phase="deltavling" onUpdateRider={updateRider} onUpdateName={updateTeamName} onRemoveTeam={removeTeam} onAddRider={addRider} onRemoveRider={removeRider} canRemoveTeam={false} />;
              })}
            </div>

            <button onClick={finishDeltavling} style={{ ...calcBtnStyle, width: "100%", marginTop: 20 }}>
              Avsluta deltävling → Visa kvalresultat
            </button>
          </>
        )}

        {/* ═══ MELLANRESULTAT ═══ */}
        {phase === "mellanresultat" && (
          <>
            <InfoBox color="#f59e0b" title="Kvalresultat – Deltävling" text="Lag med 3 eller fler felfria går vidare till final." />

            {/* Qualified */}
            <SectionLabel color="#34d399" label={`Kvalificerade till final (${qualifiedCount} lag)`} />
            {teams.filter(t => getStats(t).qualified).map(team => {
              const s = getStats(team);
              return (
                <div key={team.id} style={{ ...resultCardStyle, borderColor: "rgba(52,211,153,0.25)", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: "#e8edf4" }}>{team.name}</div>
                      <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{s.clearCount} av {s.total} felfria</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 22 }}>✅</span>
                      <div style={{ fontWeight: 800, fontSize: 18, color: "#34d399" }}>Vidare</div>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Not qualified */}
            {notQualifiedCount > 0 && (
              <>
                <SectionLabel color="#f87171" label={`Ej kvalificerade (${notQualifiedCount} lag)`} />
                {teams.filter(t => getStats(t).allDone && !getStats(t).qualified).map(team => {
                  const s = getStats(team);
                  return (
                    <div key={team.id} style={{ ...resultCardStyle, borderColor: "rgba(248,113,113,0.2)", marginBottom: 10, opacity: 0.7 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div>
                          <div style={{ fontSize: 16, fontWeight: 800, color: "#94a3b8" }}>{team.name}</div>
                          <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>{s.clearCount} av {s.total} felfria — behövde minst 3</div>
                        </div>
                        <span style={{ fontSize: 22 }}>❌</span>
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            {/* Not finished */}
            {teams.some(t => !getStats(t).allDone) && (
              <>
                <SectionLabel color="#f59e0b" label="Ej färdigridna" />
                {teams.filter(t => !getStats(t).allDone).map(team => {
                  const s = getStats(team);
                  return (
                    <div key={team.id} style={{ ...resultCardStyle, borderColor: "rgba(245,158,11,0.2)", marginBottom: 10, opacity: 0.6 }}>
                      <div style={{ fontSize: 16, fontWeight: 800, color: "#94a3b8" }}>{team.name}</div>
                      <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>{s.ridden} av {s.total} har ridit</div>
                    </div>
                  );
                })}
              </>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button onClick={() => setPhase("deltavling")} style={{ ...resetBtnStyle, flex: 1, borderColor: "rgba(56,189,248,0.3)", color: "#38bdf8", background: "rgba(56,189,248,0.1)" }}>
                ← Tillbaka
              </button>
              <button onClick={startFinal} disabled={qualifiedCount === 0}
                style={{ ...calcBtnStyle, flex: 2, background: qualifiedCount > 0 ? "linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)" : "rgba(255,255,255,0.05)", boxShadow: qualifiedCount > 0 ? "0 4px 20px rgba(167,139,250,0.3)" : "none", color: qualifiedCount > 0 ? "#fff" : "#334155" }}>
                Starta final ({qualifiedCount} lag) →
              </button>
            </div>
          </>
        )}

        {/* ═══ FINAL PHASE ═══ */}
        {phase === "final" && (
          <>
            <InfoBox color="#a78bfa" title="Final" text="Alla ryttare rider igen. Laget med högst procent felfria vinner. Minst 3 felfria krävs för resultat." />

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {finalTeams.map(team => (
                <TeamCard key={team.id} team={team} stats={getStats(team)} phase="final" onUpdateRider={updateFinalRider} onUpdateName={() => {}} onRemoveTeam={() => {}} onAddRider={() => {}} onRemoveRider={() => {}} canRemoveTeam={false} />
              ))}
            </div>

            <button onClick={finishFinal} style={{ ...calcBtnStyle, width: "100%", marginTop: 20, background: "linear-gradient(135deg, #34d399 0%, #059669 100%)", boxShadow: "0 4px 20px rgba(52,211,153,0.3)", color: "#fff" }}>
              Visa slutresultat 🏆
            </button>
          </>
        )}

        {/* ═══ SLUTRESULTAT ═══ */}
        {phase === "slutresultat" && (
          <>
            <div style={{ textAlign: "center", marginBottom: 20, animation: "fadeIn 0.4s ease" }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>🏆</div>
              <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#f1f5f9" }}>Slutresultat</h2>
              <p style={{ margin: "4px 0 0", fontSize: 13, color: "#64748b" }}>Procent tillämpning — Högst procent vinner</p>
            </div>

            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 18, overflow: "hidden", animation: "fadeIn 0.3s ease" }}>
              <div style={{ padding: "8px 12px 12px" }}>
                {rankTeams(finalTeams).map((team, i) => <ResultRow key={team.id} team={team} index={i} />)}
              </div>
            </div>

            {/* Detail per team */}
            <details style={{ marginTop: 16 }}>
              <summary style={{ cursor: "pointer", color: "#64748b", fontSize: 13, fontWeight: 600, listStyle: "none", display: "flex", alignItems: "center", gap: 6, padding: "10px 0" }}>
                <span className="ref-arrow" style={{ fontSize: 10, display: "inline-block", transition: "transform 0.2s" }}>▶</span>
                Visa detaljer per lag
              </summary>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
                {rankTeams(finalTeams).map(team => (
                  <div key={team.id} style={{ ...resultCardStyle, borderColor: "rgba(255,255,255,0.08)" }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color: "#e8edf4", marginBottom: 8 }}>
                      {team.name} {team.percent !== null && <span style={{ color: "#fbbf24" }}>— {team.percent}%</span>}
                    </div>
                    {team.riders.map((r, j) => (
                      <div key={r.id} style={{ display: "flex", gap: 8, fontSize: 13, color: "#94a3b8", padding: "3px 0" }}>
                        <span style={{ color: r.clear ? "#34d399" : "#f87171", fontWeight: 700, width: 16 }}>{r.clear ? "✓" : "✗"}</span>
                        <span>{r.name || `Ryttare ${j + 1}`}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </details>

            <button onClick={resetAll} style={{ ...resetBtnStyle, width: "100%", marginTop: 20 }}>
              Ny tävling
            </button>
          </>
        )}

        {/* Reference table (always available) */}
        {(phase === "setup" || phase === "deltavling" || phase === "final") && (
          <details style={{ marginTop: 28 }}>
            <summary style={{ cursor: "pointer", color: "#64748b", fontSize: 13, fontWeight: 600, padding: "10px 0", listStyle: "none", display: "flex", alignItems: "center", gap: 6 }}>
              <span className="ref-arrow" style={{ fontSize: 10, display: "inline-block", transition: "transform 0.2s" }}>▶</span>
              Referenstabell – Procentsatser
            </summary>
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: 16, marginTop: 8, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr><th style={thStyle}>Lagmedl.</th>{[8,7,6,5,4,3].map(n => <th key={n} style={thStyle}>{n} felfria</th>)}</tr></thead>
                <tbody>{[8,7,6,5,4,3].map(total => (
                  <tr key={total}><td style={{ ...tdStyle, fontWeight: 700, color: "#94a3b8" }}>{total}</td>
                    {[8,7,6,5,4,3].map(clear => <td key={clear} style={tdStyle}>{clear <= total && clear >= 3 ? <span style={{ color: clear === total ? "#34d399" : "#e8edf4" }}>{Math.round((clear/total)*100)}%</span> : <span style={{ color: "#334155" }}>–</span>}</td>)}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </details>
        )}
      </div>
      <style>{`
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        details[open] .ref-arrow{transform:rotate(90deg)}
        
        /* Mobile responsive */
        @media (max-width: 480px) {
          input, textarea, button { font-size: 16px !important; } /* prevent iOS zoom */
        }
        
        /* Touch-friendly tap targets */
        button { min-height: 44px; }
        
        /* Smooth scrolling */
        html { scroll-behavior: smooth; }
        
        /* Selection color */
        ::selection { background: rgba(251,191,36,0.3); color: #fff; }
        
        /* Scrollbar styling */
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
      `}</style>
    </div>
  );
}

/* ─── Info Box ─── */
function InfoBox({ color, title, text }) {
  return (
    <div style={{ background: `${color}11`, border: `1px solid ${color}33`, borderRadius: 14, padding: "14px 18px", marginBottom: 18, animation: "fadeIn 0.3s ease" }}>
      <div style={{ fontSize: 14, fontWeight: 800, color, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.5 }}>{text}</div>
    </div>
  );
}

function SectionLabel({ color, label }) {
  return <div style={{ fontSize: 13, fontWeight: 700, color, margin: "18px 0 8px", display: "flex", alignItems: "center", gap: 8 }}>
    <div style={{ width: 12, height: 2, background: color, borderRadius: 1 }} />{label}
  </div>;
}

/* ─── Import Panel ─── */
function ImportPanel({ importText, setImportText, importStatus, setImportStatus, importing, fileRef, handleFile, applyImport, previewData }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 18, padding: 20, marginBottom: 20, animation: "fadeIn 0.25s ease" }}>
      <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800, color: "#f1f5f9" }}>Importera laguppställning</h3>
      <p style={{ margin: "0 0 14px", fontSize: 12, color: "#64748b" }}>Equipe-PDF — ryttarna grupperas per klubb som lag.</p>
      <div style={{ border: "2px dashed rgba(56,189,248,0.2)", borderRadius: 14, padding: "24px 16px", textAlign: "center", marginBottom: 16, background: "rgba(56,189,248,0.03)", cursor: "pointer" }}
        onClick={() => fileRef.current?.click()}
        onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = "rgba(56,189,248,0.5)"; }}
        onDragLeave={e => { e.currentTarget.style.borderColor = "rgba(56,189,248,0.2)"; }}
        onDrop={e => { e.preventDefault(); e.currentTarget.style.borderColor = "rgba(56,189,248,0.2)"; const f = e.dataTransfer.files?.[0]; if (f) handleFile({ target: { files: [f] } }); }}>
        <input ref={fileRef} type="file" accept=".pdf,.txt,.csv" onChange={handleFile} style={{ display: "none" }} />
        <div style={{ fontSize: 32, marginBottom: 8 }}>{importing ? "⏳" : "📄"}</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#94a3b8" }}>{importing ? "Läser in..." : "Klicka eller dra fil hit"}</div>
        <div style={{ fontSize: 12, color: "#475569" }}>PDF, TXT eller CSV</div>
      </div>
      {importStatus && <div style={{ padding: "10px 14px", borderRadius: 10, marginBottom: 12, fontSize: 13, fontWeight: 600, background: importStatus.type === "success" ? "rgba(52,211,153,0.1)" : "rgba(248,113,113,0.1)", color: importStatus.type === "success" ? "#34d399" : "#f87171", border: `1px solid ${importStatus.type === "success" ? "rgba(52,211,153,0.2)" : "rgba(248,113,113,0.2)"}` }}>{importStatus.msg}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "16px 0" }}><div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.06)" }} /><span style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>ELLER TEXT</span><div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.06)" }} /></div>
      <textarea value={importText} onChange={e => { setImportText(e.target.value); setImportStatus(null); }}
        placeholder={`Kungsbacka RK:\nElise Jarhäll\nAgnes Hannell`}
        style={{ width: "100%", boxSizing: "border-box", minHeight: 120, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 14, color: "#e8edf4", fontSize: 13, fontFamily: "monospace", lineHeight: 1.6, outline: "none", resize: "vertical" }} />
      {previewData.length > 0 && (
        <div style={{ marginTop: 12, padding: 14, background: "rgba(52,211,153,0.05)", border: "1px solid rgba(52,211,153,0.15)", borderRadius: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#34d399", marginBottom: 8 }}>{previewData.length} lag, {previewData.reduce((s, t) => s + t.riders.length, 0)} ryttare</div>
          {previewData.map((t, i) => <div key={i} style={{ marginBottom: 8 }}><div style={{ fontSize: 13, fontWeight: 700, color: "#e8edf4" }}>{t.name} ({t.riders.length})</div><div style={{ fontSize: 12, color: "#64748b", paddingLeft: 12 }}>{t.riders.slice(0, 8).map((r, j) => <div key={j}>{j + 1}. {r}</div>)}</div></div>)}
        </div>
      )}
      <button onClick={applyImport} disabled={!importText.trim()} style={{ width: "100%", padding: "14px", marginTop: 14, background: importText.trim() ? "linear-gradient(135deg, #38bdf8, #0ea5e9)" : "rgba(255,255,255,0.05)", border: "none", borderRadius: 12, color: importText.trim() ? "#0a1628" : "#334155", fontSize: 15, fontWeight: 800, cursor: importText.trim() ? "pointer" : "default" }}>
        Importera {previewData.length > 0 ? `${previewData.length} lag` : ""}
      </button>
    </div>
  );
}

/* ─── Team Card ─── */
function TeamCard({ team, stats, phase, onUpdateName, onRemoveTeam, onAddRider, onRemoveRider, onUpdateRider, canRemoveTeam }) {
  const { total, ridden, clearCount, allDone, qualified, percent } = stats;
  const progress = total > 0 ? (ridden / total) * 100 : 0;
  const isActive = phase === "deltavling" || phase === "final";
  const showQualBadge = phase === "deltavling" && allDone;

  return (
    <div style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${showQualBadge ? (qualified ? "rgba(52,211,153,0.3)" : "rgba(248,113,113,0.25)") : allDone && percent !== null ? "rgba(52,211,153,0.25)" : "rgba(255,255,255,0.08)"}`, borderRadius: 18, overflow: "hidden", transition: "border-color 0.3s" }}>
      <div style={{ padding: "16px 18px 12px", display: "flex", alignItems: "center", gap: 10 }}>
        <input value={team.name} onChange={e => onUpdateName(team.id, e.target.value)} readOnly={isActive}
          style={{ background: "transparent", border: "none", borderBottom: "1px solid transparent", color: "#e8edf4", fontSize: 17, fontWeight: 800, padding: "2px 0", outline: "none", flex: 1, minWidth: 0, cursor: isActive ? "default" : "text" }}
          onFocus={e => !isActive && (e.target.style.borderBottomColor = "rgba(251,191,36,0.4)")}
          onBlur={e => (e.target.style.borderBottomColor = "transparent")} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.06)", borderRadius: 10, padding: "5px 10px", fontSize: 12, fontWeight: 600, color: "#94a3b8" }}>
            <span style={{ color: "#34d399" }}>{clearCount}</span><span style={{ color: "#475569" }}>/</span><span>{total}</span>
          </div>
          {percent !== null && <div style={{ background: percent === 100 ? "linear-gradient(135deg, #059669, #10b981)" : "linear-gradient(135deg, rgba(251,191,36,0.2), rgba(251,191,36,0.1))", color: percent === 100 ? "#fff" : "#fbbf24", fontWeight: 800, fontSize: 16, padding: "5px 14px", borderRadius: 10 }}>{percent}%</div>}
          {showQualBadge && <div style={{ padding: "4px 10px", borderRadius: 8, fontSize: 11, fontWeight: 700, background: qualified ? "rgba(52,211,153,0.15)" : "rgba(248,113,113,0.12)", color: qualified ? "#34d399" : "#f87171" }}>{qualified ? "Vidare ✓" : "Ej vidare"}</div>}
          {canRemoveTeam && phase === "setup" && <button onClick={() => onRemoveTeam(team.id)} style={removeBtnStyle} onMouseEnter={e => e.currentTarget.style.color = "#f87171"} onMouseLeave={e => e.currentTarget.style.color = "#475569"}>×</button>}
        </div>
      </div>
      <div style={{ height: 3, background: "rgba(255,255,255,0.05)", margin: "0 18px" }}>
        <div style={{ height: "100%", borderRadius: 2, background: allDone ? (qualified ? "#34d399" : "#f87171") : "#fbbf24", width: `${progress}%`, transition: "width 0.4s ease, background 0.3s" }} />
      </div>
      <div style={{ padding: "12px 18px 6px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 0 8px", marginBottom: 4, borderBottom: "1px solid rgba(255,255,255,0.04)", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, color: "#475569" }}>
          <span style={{ width: 28, textAlign: "center" }}>#</span><span style={{ flex: 1 }}>Ryttare</span>
          {isActive && <span style={{ width: 110, textAlign: "center" }}>Resultat</span>}
          {phase === "setup" && <span style={{ width: 28 }}></span>}
        </div>
        {team.riders.map((rider, idx) => (
          <RiderRow key={rider.id} rider={rider} index={idx} teamId={team.id} onUpdate={onUpdateRider} onRemove={onRemoveRider} canRemove={phase === "setup" && team.riders.length > 3} showButtons={isActive} />
        ))}
      </div>
      {phase === "setup" && team.riders.length < 8 && (
        <button onClick={() => onAddRider(team.id)} style={{ width: "calc(100% - 36px)", margin: "4px 18px 14px", padding: "10px", background: "rgba(255,255,255,0.03)", border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 10, color: "#475569", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
          onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "#94a3b8"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; e.currentTarget.style.color = "#475569"; }}>
          + Ryttare ({team.riders.length}/8)
        </button>
      )}
    </div>
  );
}

/* ─── Rider Row ─── */
function RiderRow({ rider, index, teamId, onUpdate, onRemove, canRemove, showButtons }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
      <div style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: rider.clear === true ? "#34d399" : rider.clear === false ? "#f87171" : "#475569", background: rider.clear === true ? "rgba(52,211,153,0.1)" : rider.clear === false ? "rgba(248,113,113,0.1)" : "rgba(255,255,255,0.04)", borderRadius: 8, transition: "all 0.2s" }}>
        {rider.clear === true ? "✓" : rider.clear === false ? "✗" : index + 1}
      </div>
      <input value={rider.name} onChange={e => onUpdate(teamId, rider.id, "name", e.target.value)} placeholder={`Ryttare ${index + 1}`} readOnly={showButtons}
        style={{ flex: 1, minWidth: 0, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: "8px 10px", color: "#e8edf4", fontSize: 14, fontWeight: 500, outline: "none", cursor: showButtons ? "default" : "text" }} />
      {showButtons && (
        <div style={{ display: "flex", gap: 4, width: 110, justifyContent: "center" }}>
          <button onClick={() => onUpdate(teamId, rider.id, "clear", rider.clear === true ? null : true)}
            style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", border: "none", background: rider.clear === true ? "rgba(52,211,153,0.2)" : "rgba(255,255,255,0.04)", color: rider.clear === true ? "#34d399" : "#475569", boxShadow: rider.clear === true ? "inset 0 0 0 1.5px rgba(52,211,153,0.4)" : "inset 0 0 0 1px rgba(255,255,255,0.08)", transition: "all 0.15s" }}>Felfri</button>
          <button onClick={() => onUpdate(teamId, rider.id, "clear", rider.clear === false ? null : false)}
            style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", border: "none", background: rider.clear === false ? "rgba(248,113,113,0.2)" : "rgba(255,255,255,0.04)", color: rider.clear === false ? "#f87171" : "#475569", boxShadow: rider.clear === false ? "inset 0 0 0 1.5px rgba(248,113,113,0.4)" : "inset 0 0 0 1px rgba(255,255,255,0.08)", transition: "all 0.15s" }}>Fel</button>
        </div>
      )}
      {canRemove ? <button onClick={() => onRemove(teamId, rider.id)} style={{ ...removeBtnStyle, width: 28, color: "#334155" }} onMouseEnter={e => e.currentTarget.style.color = "#f87171"} onMouseLeave={e => e.currentTarget.style.color = "#334155"}>×</button> : !showButtons && <div style={{ width: 28 }} />}
    </div>
  );
}

/* ─── Result Row ─── */
function ResultRow({ team, index }) {
  const isTop3 = team.rank <= 3 && team.percent !== null;
  const medals = { 1: "🥇", 2: "🥈", 3: "🥉" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 12px", borderRadius: 12, background: isTop3 ? "rgba(251,191,36,0.06)" : "transparent", borderBottom: "1px solid rgba(255,255,255,0.03)", animation: `fadeIn 0.3s ease ${index * 0.06}s both` }}>
      <div style={{ minWidth: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", fontSize: isTop3 ? 22 : 15, fontWeight: 800, color: team.rank === "-" ? "#334155" : isTop3 ? "#fbbf24" : "#64748b", background: isTop3 ? "rgba(251,191,36,0.1)" : "rgba(255,255,255,0.03)", borderRadius: 12 }}>
        {medals[team.rank] || team.rank}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: team.percent !== null ? "#e8edf4" : "#475569" }}>{team.name}</div>
        <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{team.clearCount} av {team.total} felfria</div>
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: team.percent !== null ? (team.percent === 100 ? "#34d399" : "#fbbf24") : "#334155", fontVariantNumeric: "tabular-nums" }}>
        {team.percent !== null ? `${team.percent}%` : "–"}
      </div>
    </div>
  );
}

/* ─── Styles ─── */
const resultCardStyle = { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: "14px 18px" };
const thStyle = { padding: "8px 6px", textAlign: "center", color: "#64748b", fontWeight: 600, fontSize: 11, borderBottom: "1px solid rgba(255,255,255,0.06)" };
const tdStyle = { padding: "8px 6px", textAlign: "center", borderBottom: "1px solid rgba(255,255,255,0.04)" };
const removeBtnStyle = { background: "none", border: "none", color: "#475569", fontSize: 18, cursor: "pointer", padding: "2px 6px", borderRadius: 6, transition: "color 0.2s" };
const addBtnStyle = { width: "100%", marginTop: 12, padding: "14px", background: "rgba(255,255,255,0.04)", border: "1px dashed rgba(255,255,255,0.15)", borderRadius: 14, color: "#64748b", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "all 0.2s" };
const calcBtnStyle = { flex: 1, padding: "16px", background: "linear-gradient(135deg, #fbbf24, #f59e0b)", border: "none", borderRadius: 14, color: "#0a1628", fontSize: 16, fontWeight: 800, cursor: "pointer", boxShadow: "0 4px 20px rgba(251,191,36,0.3)", transition: "transform 0.15s", letterSpacing: 0.3 };
const resetBtnStyle = { padding: "16px 20px", background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 14, color: "#f87171", fontSize: 14, fontWeight: 600, cursor: "pointer", transition: "all 0.2s" };
