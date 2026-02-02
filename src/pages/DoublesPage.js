// src/pages/DoublesPage.js
import React, { useEffect, useMemo, useState } from "react";
import Header from "../components/Header";
import { db, ensureAnonAuth } from "../firebase";
import {
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  updateDoc,
  deleteField,
} from "firebase/firestore";

const LEAGUE_ID = "default-league";
const ADMIN_PASSWORD = "Pescado!";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function scoreLabel(n) {
  if (n === 0) return "E";
  return n > 0 ? `+${n}` : `${n}`;
}

export default function DoublesPage() {
  const COLORS = {
    blueLight: "#e6f3ff",
    navy: "#1b1f5a",
    orange: "#f4a83a",
    card: "#ffffff",
    border: "rgba(27,31,90,0.25)",
    muted: "rgba(0,0,0,0.6)",
    green: "#1a7f37",
    red: "#b42318",
  };

  const leagueRef = useMemo(() => doc(db, "leagues", LEAGUE_ID), []);
  const [loading, setLoading] = useState(true);

  // Doubles state from Firestore
  const [doubles, setDoubles] = useState(null);

  // UI state
  const [todayExpanded, setTodayExpanded] = useState(true);
  const [adminExpanded, setAdminExpanded] = useState(false);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminPw, setAdminPw] = useState("");

  // Check-in UI
  const [checkinName, setCheckinName] = useState("");
  const [checkinPool, setCheckinPool] = useState("A");

  // Admin settings UI
  const [formatChoice, setFormatChoice] = useState("random"); // "random" | "seated"
  const [caliMode, setCaliMode] = useState("random"); // "random" | "manual"
  const [manualCaliId, setManualCaliId] = useState("");
  const [layoutNote, setLayoutNote] = useState("");

  // Cards UI
  const [expandedCardId, setExpandedCardId] = useState(null);
  const [scoreDraftByCard, setScoreDraftByCard] = useState({}); // cardId -> score (-18..18)
  const [submitMsgByCard, setSubmitMsgByCard] = useState({}); // cardId -> string

  // Admin: edit holes
  const [editHolesOpen, setEditHolesOpen] = useState(false);
  const [holeEdits, setHoleEdits] = useState({}); // cardId -> holeNumber

  // Admin: late player
  const [lateName, setLateName] = useState("");
  const [latePool, setLatePool] = useState("A");
  const [lateCardId, setLateCardId] = useState("");
  const [lateAction, setLateAction] = useState("auto"); // auto behavior described below
  const [lateMsg, setLateMsg] = useState("");

  // Ensure baseline shape
  const defaultDoubles = useMemo(
    () => ({
      started: false,
      format: "random", // random | seated
      caliMode: "random", // random | manual
      manualCaliId: "",
      layoutNote: "",
      checkins: [], // [{id,name,pool}]
      cali: {
        playerId: "", // checkin id
        teammateId: "", // checkin id (when late arrives)
      },
      cards: [], // [{id, startHole, teams:[{id,type:"doubles"|"cali", players:[{id,name,pool}]}]}]
      submissions: {}, // cardId -> {submittedAt, score, label}
      leaderboard: [], // [{teamId, teamName, playersText, score}]
      updatedAt: Date.now(),
    }),
    []
  );

  useEffect(() => {
    ensureAnonAuth().catch(() => {});
    const unsub = onSnapshot(
      leagueRef,
      async (snap) => {
        if (!snap.exists()) {
          await setDoc(
            leagueRef,
            { doubles: defaultDoubles, createdAt: Date.now() },
            { merge: true }
          );
          setLoading(false);
          return;
        }
        const data = snap.data() || {};
        const d = data.doubles || defaultDoubles;
        setDoubles(d);
        setLoading(false);

        // keep admin UI synced (only when not unlocked OR first load)
        setFormatChoice(d.format || "random");
        setCaliMode(d.caliMode || "random");
        setManualCaliId(d.manualCaliId || "");
        setLayoutNote(d.layoutNote || "");

        // default late card selection
        if (!lateCardId && (d.cards || []).length) {
          setLateCardId(d.cards[0].id);
        }
      },
      () => setLoading(false)
    );
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagueRef, defaultDoubles]);

  const isSeated = (doubles?.format || "random") === "seated";
  const started = !!doubles?.started;

  const checkins = doubles?.checkins || [];
  const cards = doubles?.cards || [];
  const submissions = doubles?.submissions || {};
  const leaderboard = doubles?.leaderboard || [];

  const checkinStatus = useMemo(() => {
    if (!checkins.length) return "No players checked in yet.";
    if (!isSeated) return `${checkins.length} player(s) checked in.`;
    const a = checkins.filter((p) => p.pool === "A").length;
    const b = checkins.filter((p) => p.pool === "B").length;
    return `${checkins.length} checked in (A: ${a}, B: ${b}).`;
  }, [checkins, isSeated]);

  const formatSummary = useMemo(() => {
    const fmt = doubles?.format || "random";
    const fmtLabel =
      fmt === "seated" ? "Seated Doubles (A/B)" : "Random Doubles";
    const caliLabel =
      (doubles?.caliMode || "random") === "manual"
        ? "Cali: Admin selects (only if odd #)"
        : "Cali: Random (only if odd #)";
    return { fmtLabel, caliLabel };
  }, [doubles]);

  async function saveAdminSettings() {
    if (!adminUnlocked) return;
    await updateDoc(leagueRef, {
      "doubles.format": formatChoice,
      "doubles.caliMode": caliMode,
      "doubles.manualCaliId": caliMode === "manual" ? manualCaliId : "",
      "doubles.layoutNote": layoutNote || "",
      "doubles.updatedAt": Date.now(),
    });
  }

  async function addCheckin() {
    const name = checkinName.trim();
    if (!name) return;

    // prevent duplicates by name (soft)
    const exists = checkins.some(
      (p) => (p.name || "").toLowerCase() === name.toLowerCase()
    );
    if (exists) {
      setCheckinName("");
      return;
    }

    const player = {
      id: uid(),
      name,
      pool: isSeated ? checkinPool : "",
      createdAt: Date.now(),
    };

    await updateDoc(leagueRef, {
      "doubles.checkins": [...checkins, player],
      "doubles.updatedAt": Date.now(),
    });

    setCheckinName("");
  }

  function pickCali(checkinsList, fmt, mode, manualId) {
    // Returns {caliId, checkinsRemaining}
    if (checkinsList.length % 2 === 0) {
      return { caliId: "", remaining: [...checkinsList] };
    }

    if (fmt === "seated") {
      const A = checkinsList.filter((p) => p.pool === "A");
      const B = checkinsList.filter((p) => p.pool === "B");

      // Determine which pool is odd (or fallback)
      const oddPool = A.length % 2 === 1 ? "A" : B.length % 2 === 1 ? "B" : "A";
      const poolList = checkinsList.filter((p) => p.pool === oddPool);

      let chosen = null;
      if (mode === "manual" && manualId) {
        chosen = poolList.find((p) => p.id === manualId) || null;
      }
      if (!chosen) {
        chosen = shuffle(poolList)[0] || null;
      }
      if (!chosen) return { caliId: "", remaining: [...checkinsList] };

      const remaining = checkinsList.filter((p) => p.id !== chosen.id);
      return { caliId: chosen.id, remaining };
    }

    // Random Doubles
    let chosen = null;
    if (mode === "manual" && manualId) {
      chosen = checkinsList.find((p) => p.id === manualId) || null;
    }
    if (!chosen) chosen = shuffle(checkinsList)[0] || null;
    if (!chosen) return { caliId: "", remaining: [...checkinsList] };

    const remaining = checkinsList.filter((p) => p.id !== chosen.id);
    return { caliId: chosen.id, remaining };
  }

  function buildTeamsAndCards(checkinsList, fmt, caliInfo) {
    // fmt: "random" | "seated"
    // caliInfo: { caliId, remaining }
    const remaining = [...caliInfo.remaining];
    const caliId = caliInfo.caliId;

    const idToPlayer = new Map(checkinsList.map((p) => [p.id, p]));
    const caliPlayer = caliId ? idToPlayer.get(caliId) : null;

    let teams = [];

    if (fmt === "seated") {
      const A = remaining.filter((p) => p.pool === "A");
      const B = remaining.filter((p) => p.pool === "B");
      const min = Math.min(A.length, B.length);
      const As = shuffle(A);
      const Bs = shuffle(B);

      for (let i = 0; i < min; i++) {
        const tId = uid();
        teams.push({
          id: tId,
          type: "doubles",
          players: [
            { id: As[i].id, name: As[i].name, pool: "A" },
            { id: Bs[i].id, name: Bs[i].name, pool: "B" },
          ],
        });
      }

      // if mismatched pools (should only happen if admin didn't balance),
      // push leftovers as singles to be handled by cali or regrouping.
      const leftover = [...As.slice(min), ...Bs.slice(min)];
      // If there are leftovers, we will try to pack them into teams of 2 (randomly),
      // but still keep a playable card structure.
      const leftoverShuffled = shuffle(leftover);
      for (let i = 0; i + 1 < leftoverShuffled.length; i += 2) {
        teams.push({
          id: uid(),
          type: "doubles",
          players: [
            {
              id: leftoverShuffled[i].id,
              name: leftoverShuffled[i].name,
              pool: leftoverShuffled[i].pool,
            },
            {
              id: leftoverShuffled[i + 1].id,
              name: leftoverShuffled[i + 1].name,
              pool: leftoverShuffled[i + 1].pool,
            },
          ],
        });
      }
    } else {
      const shuffled = shuffle(remaining);
      for (let i = 0; i + 1 < shuffled.length; i += 2) {
        teams.push({
          id: uid(),
          type: "doubles",
          players: [
            { id: shuffled[i].id, name: shuffled[i].name, pool: "" },
            { id: shuffled[i + 1].id, name: shuffled[i + 1].name, pool: "" },
          ],
        });
      }
    }

    // Build cards:
    // - Standard: 2 teams per card (4 players)
    // - If cali exists: add cali as a third "team" (solo) to the first card => 5 players, 3 teams
    // - Never allow a card with only 1 team.
    // If we end up with an odd number of teams (shouldn't, but just in case), we merge last team into previous card.
    const cardTeams = [...teams];
    const cardsOut = [];
    let startHole = 1;

    function nextStartHole() {
      const h = startHole;
      startHole += 2; // hole gap
      return h;
    }

    while (cardTeams.length >= 2) {
      const cId = uid();
      const t1 = cardTeams.shift();
      const t2 = cardTeams.shift();
      cardsOut.push({
        id: cId,
        startHole: nextStartHole(),
        teams: [t1, t2],
      });
    }

    // If a leftover team exists, merge into last card (making it 3 teams / 6 players)
    if (cardTeams.length === 1) {
      const lone = cardTeams[0];
      if (cardsOut.length === 0) {
        // can't create a single-team card; ignore (shouldn't happen)
      } else {
        cardsOut[cardsOut.length - 1].teams.push(lone);
      }
    }

    // Add Cali if needed
    let cali = { playerId: "", teammateId: "" };
    if (caliPlayer) {
      cali.playerId = caliPlayer.id;
      cali.teammateId = ""; // can be filled by late player
      const caliTeam = {
        id: uid(),
        type: "cali",
        players: [
          {
            id: caliPlayer.id,
            name: caliPlayer.name,
            pool: caliPlayer.pool || "",
          },
        ],
      };

      if (cardsOut.length === 0) {
        // Not enough teams to make cards; still store cali selection.
      } else {
        // Put Cali on the first card as a third team (5 players total)
        cardsOut[0].teams.push(caliTeam);
      }
    }

    return { cardsOut, cali };
  }

  function teamDisplay(team) {
    const names = (team.players || []).map((p) => p.name).filter(Boolean);
    if (team.type === "cali") {
      if (names.length === 2) return `Cali Team: ${names[0]} & ${names[1]}`;
      return `Cali: ${names[0] || "—"}`;
    }
    return `${names[0] || "—"} & ${names[1] || "—"}`;
  }

  function teamPlayersText(team) {
    const names = (team.players || []).map((p) => p.name).filter(Boolean);
    return names.join(", ");
  }

  async function makeTeamsAndCards() {
    if (!adminUnlocked) return;
    if (checkins.length < 4) return; // need at least 4 for a normal doubles card

    // Save admin settings first so everyone sees it
    await saveAdminSettings();

    const fmt = formatChoice;
    const mode = caliMode;
    const manualId = mode === "manual" ? manualCaliId : "";

    const caliInfo = pickCali(checkins, fmt, mode, manualId);
    const built = buildTeamsAndCards(checkins, fmt, caliInfo);

    // Leaderboard clears for a new start
    await updateDoc(leagueRef, {
      "doubles.started": true,
      "doubles.format": fmt,
      "doubles.caliMode": mode,
      "doubles.manualCaliId": mode === "manual" ? manualId : "",
      "doubles.layoutNote": layoutNote || "",
      "doubles.cali": built.cali,
      "doubles.cards": built.cardsOut,
      "doubles.submissions": {},
      "doubles.leaderboard": [],
      "doubles.updatedAt": Date.now(),
    });

    // Collapse Today section after start
    setTodayExpanded(false);
  }

  async function eraseDoublesInfo() {
    if (!adminUnlocked) return;
    await updateDoc(leagueRef, {
      doubles: defaultDoubles,
      "doubles.updatedAt": Date.now(),
    });
    setExpandedCardId(null);
    setScoreDraftByCard({});
    setSubmitMsgByCard({});
    setHoleEdits({});
    setLateMsg("");
    setLateName("");
  }

  async function submitCardScore(cardId) {
    const n = Number(scoreDraftByCard[cardId] ?? 0);
    const score = clamp(isNaN(n) ? 0 : n, -18, 18);

    const card = cards.find((c) => c.id === cardId);
    if (!card) return;

    // Add/update leaderboard entries for each team on the card
    const newEntries = (card.teams || []).map((t) => ({
      teamId: t.id,
      teamName: t.type === "cali" ? "Cali" : "Team",
      playersText: teamPlayersText(t),
      score,
    }));

    // merge into existing leaderboard by teamId
    const existing = [...leaderboard];
    const byId = new Map(existing.map((e) => [e.teamId, e]));
    for (const e of newEntries) byId.set(e.teamId, e);

    const merged = Array.from(byId.values()).sort((a, b) => a.score - b.score);

    await updateDoc(leagueRef, {
      [`doubles.submissions.${cardId}`]: {
        submittedAt: Date.now(),
        score,
        label: scoreLabel(score),
      },
      "doubles.leaderboard": merged,
      "doubles.updatedAt": Date.now(),
    });

    setSubmitMsgByCard((m) => ({
      ...m,
      [cardId]: `Submitted! Score: ${scoreLabel(score)}.`,
    }));
    setTimeout(() => {
      setSubmitMsgByCard((m) => ({ ...m, [cardId]: "" }));
    }, 2500);
  }

  async function saveStartingHoleEdits() {
    if (!adminUnlocked) return;
    const updatedCards = cards.map((c) => {
      const proposed = holeEdits[c.id];
      if (proposed === undefined || proposed === null || proposed === "")
        return c;
      const val = clamp(parseInt(proposed, 10) || c.startHole, 1, 18);
      return { ...c, startHole: val };
    });

    await updateDoc(leagueRef, {
      "doubles.cards": updatedCards,
      "doubles.updatedAt": Date.now(),
    });
    setEditHolesOpen(false);
  }

  function findOpenCaliTeam(cardsList) {
    // cali team is type="cali". If it has 1 player only, it's "open".
    for (const c of cardsList) {
      const t = (c.teams || []).find((x) => x.type === "cali");
      if (t && (t.players || []).length === 1)
        return { cardId: c.id, teamId: t.id };
    }
    return null;
  }

  async function addLatePlayer() {
    if (!adminUnlocked) return;
    setLateMsg("");

    const name = lateName.trim();
    if (!name) return;

    // add to checkins
    const already = checkins.some(
      (p) => (p.name || "").toLowerCase() === name.toLowerCase()
    );
    if (already) {
      setLateMsg("That name is already checked in.");
      return;
    }

    const newPlayer = {
      id: uid(),
      name,
      pool: (doubles?.format || "random") === "seated" ? latePool : "",
      createdAt: Date.now(),
      late: true,
    };

    const newCheckins = [...checkins, newPlayer];

    // If there is a cali solo (open), make them teammates (cali becomes 2-person team)
    const openCali = findOpenCaliTeam(cards);
    let newCards = [...cards];

    if (openCali) {
      newCards = cards.map((c) => {
        if (c.id !== openCali.cardId) return c;
        const teams = (c.teams || []).map((t) => {
          if (t.id !== openCali.teamId) return t;
          return {
            ...t,
            players: [
              ...(t.players || []),
              { id: newPlayer.id, name: newPlayer.name, pool: newPlayer.pool },
            ],
          };
        });
        return { ...c, teams };
      });

      await updateDoc(leagueRef, {
        "doubles.checkins": newCheckins,
        "doubles.cards": newCards,
        "doubles.cali": {
          ...(doubles?.cali || { playerId: "", teammateId: "" }),
          teammateId: newPlayer.id,
        },
        "doubles.updatedAt": Date.now(),
      });

      setLateMsg("Late player added as Cali teammate.");
      setLateName("");
      return;
    }

    // Otherwise, admin chooses a card and the late player becomes a Cali solo on that card.
    const targetId = lateCardId || (cards[0] ? cards[0].id : "");
    if (!targetId) {
      // No cards exist; just add to checkins
      await updateDoc(leagueRef, {
        "doubles.checkins": newCheckins,
        "doubles.updatedAt": Date.now(),
      });
      setLateMsg("Late player checked in. (No cards exist yet.)");
      setLateName("");
      return;
    }

    // Add a cali team to the chosen card (or if it already has 3 teams, append anyway)
    const caliTeam = {
      id: uid(),
      type: "cali",
      players: [
        { id: newPlayer.id, name: newPlayer.name, pool: newPlayer.pool },
      ],
    };

    newCards = cards.map((c) => {
      if (c.id !== targetId) return c;
      // If a cali team already exists but has 2 players, we still add as another cali solo (rare case)
      return { ...c, teams: [...(c.teams || []), caliTeam] };
    });

    await updateDoc(leagueRef, {
      "doubles.checkins": newCheckins,
      "doubles.cards": newCards,
      "doubles.updatedAt": Date.now(),
    });

    setLateMsg("Late player added as Cali on selected card.");
    setLateName("");
  }

  function tryUnlockAdmin() {
    if (adminPw === ADMIN_PASSWORD) {
      setAdminUnlocked(true);
      setAdminPw("");
    }
  }

  const pageWrap = {
    minHeight: "100vh",
    background: `linear-gradient(180deg, ${COLORS.blueLight} 0%, #ffffff 60%)`,
    display: "flex",
    justifyContent: "center",
    padding: 24,
  };

  const container = { width: "100%", maxWidth: 860 };

  const cardStyle = {
    background: COLORS.card,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 16,
    padding: 14,
    boxShadow: "0 8px 22px rgba(0,0,0,0.06)",
  };

  const sectionTitleRow = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    cursor: "pointer",
    userSelect: "none",
  };

  const button = (primary = true) => ({
    padding: "12px 14px",
    borderRadius: 12,
    border: `2px solid ${COLORS.navy}`,
    background: primary ? COLORS.orange : "#fff",
    fontWeight: 900,
    cursor: "pointer",
  });

  const bigAdminButton = (danger = false) => ({
    padding: "14px 18px",
    borderRadius: 14,
    border: `2px solid ${COLORS.navy}`,
    background: danger ? "#fff5f5" : COLORS.orange,
    fontWeight: 1000,
    cursor: "pointer",
    minWidth: 240,
  });

  const input = {
    width: "100%",
    padding: "12px 12px",
    borderRadius: 12,
    border: `1px solid ${COLORS.border}`,
    outline: "none",
  };

  if (loading || !doubles) {
    return (
      <div style={pageWrap}>
        <div style={container}>
          <Header />
          <div style={{ marginTop: 14, ...cardStyle }}>Loading Doubles…</div>
        </div>
      </div>
    );
  }

  return (
    <div style={pageWrap}>
      <div style={container}>
        <Header />

        {/* Today's Format (expandable) */}
        <div style={{ marginTop: 14, ...cardStyle }}>
          <div
            style={sectionTitleRow}
            onClick={() => setTodayExpanded((v) => !v)}
          >
            <div style={{ fontWeight: 1000, fontSize: 18, color: COLORS.navy }}>
              Today’s Format
            </div>
            <div style={{ color: COLORS.muted, fontWeight: 800 }}>
              {todayExpanded ? "Hide" : "Show"}
            </div>
          </div>

          {todayExpanded && (
            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              <div style={{ color: COLORS.muted, lineHeight: 1.35 }}>
                <div>
                  <b>Format:</b> {formatSummary.fmtLabel}
                </div>
                <div>
                  <b>{formatSummary.caliLabel}</b>
                </div>
                <div style={{ marginTop: 6 }}>
                  <b>Layout:</b> {doubles.layoutNote ? doubles.layoutNote : "—"}
                </div>
                <div style={{ marginTop: 6 }}>
                  <b>Check-in:</b> {checkinStatus}
                </div>
              </div>

              {/* Player Check-in card (only before round starts) */}
              {!started && (
                <div style={{ ...cardStyle, padding: 12 }}>
                  <div style={{ fontWeight: 1000, color: COLORS.navy }}>
                    Player Check-in
                  </div>

                  <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                    <input
                      style={input}
                      placeholder="Player name"
                      value={checkinName}
                      onChange={(e) => setCheckinName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addCheckin();
                      }}
                    />

                    {isSeated && (
                      <div style={{ display: "flex", gap: 10 }}>
                        <button
                          style={{
                            ...button(checkinPool === "A"),
                            flex: 1,
                            background:
                              checkinPool === "A" ? COLORS.orange : "#fff",
                          }}
                          onClick={() => setCheckinPool("A")}
                        >
                          Pool A
                        </button>
                        <button
                          style={{
                            ...button(checkinPool === "B"),
                            flex: 1,
                            background:
                              checkinPool === "B" ? COLORS.orange : "#fff",
                          }}
                          onClick={() => setCheckinPool("B")}
                        >
                          Pool B
                        </button>
                      </div>
                    )}

                    <button style={button(true)} onClick={addCheckin}>
                      Check In
                    </button>

                    {checkins.length > 0 && (
                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 13,
                          color: COLORS.muted,
                        }}
                      >
                        Checked in:{" "}
                        {checkins
                          .slice(-12)
                          .map((p) => p.name)
                          .join(", ")}
                        {checkins.length > 12 ? "…" : ""}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Leaderboard */}
        <div style={{ marginTop: 14, ...cardStyle }}>
          <div style={{ fontWeight: 1000, fontSize: 18, color: COLORS.navy }}>
            Leaderboard
          </div>

          {leaderboard.length === 0 ? (
            <div style={{ marginTop: 10, color: COLORS.muted }}>
              No scores yet.
            </div>
          ) : (
            <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
              {leaderboard.map((e) => (
                <div
                  key={e.teamId}
                  style={{
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 14,
                    padding: 12,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    alignItems: "center",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 1000, color: COLORS.navy }}>
                      {e.playersText || "Team"}
                    </div>
                    <div style={{ fontSize: 12, color: COLORS.muted }}>
                      {e.teamName}
                    </div>
                  </div>
                  <div style={{ fontWeight: 1000, fontSize: 18 }}>
                    {scoreLabel(e.score)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cards */}
        <div style={{ marginTop: 14, ...cardStyle }}>
          <div style={{ fontWeight: 1000, fontSize: 18, color: COLORS.navy }}>
            Cards
          </div>

          {!started ? (
            <div style={{ marginTop: 10, color: COLORS.muted }}>
              Cards will appear after the admin starts the round.
            </div>
          ) : cards.length === 0 ? (
            <div style={{ marginTop: 10, color: COLORS.muted }}>
              No cards found.
            </div>
          ) : (
            <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
              {cards.map((c, idx) => {
                const sub = submissions[c.id];
                const isOpen = expandedCardId === c.id;
                const statusText = sub
                  ? `Submitted: ${sub.label}`
                  : "Not submitted";
                const statusColor = sub ? COLORS.green : COLORS.muted;

                return (
                  <div
                    key={c.id}
                    style={{
                      border: `1px solid ${COLORS.border}`,
                      borderRadius: 16,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        padding: 12,
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        cursor: "pointer",
                        background: "#fff",
                      }}
                      onClick={() => setExpandedCardId(isOpen ? null : c.id)}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 1000, color: COLORS.navy }}>
                          Card {idx + 1} • Start Hole {c.startHole}
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: statusColor,
                            fontWeight: 900,
                          }}
                        >
                          {statusText}
                        </div>
                      </div>
                      <div style={{ color: COLORS.muted, fontWeight: 800 }}>
                        {isOpen ? "Hide" : "Open"}
                      </div>
                    </div>

                    {isOpen && (
                      <div
                        style={{
                          padding: 12,
                          borderTop: `1px solid ${COLORS.border}`,
                        }}
                      >
                        <div style={{ display: "grid", gap: 8 }}>
                          {(c.teams || []).map((t) => (
                            <div
                              key={t.id}
                              style={{
                                padding: 10,
                                borderRadius: 14,
                                background: "rgba(27,31,90,0.04)",
                                border: `1px solid ${COLORS.border}`,
                              }}
                            >
                              <div style={{ fontWeight: 1000 }}>
                                {teamDisplay(t)}
                              </div>
                              {isSeated && (
                                <div
                                  style={{ fontSize: 12, color: COLORS.muted }}
                                >
                                  {(t.players || [])
                                    .map((p) =>
                                      p.pool ? `${p.name} (${p.pool})` : p.name
                                    )
                                    .join(" • ")}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>

                        <div
                          style={{ marginTop: 12, ...cardStyle, padding: 12 }}
                        >
                          <div style={{ fontWeight: 1000, color: COLORS.navy }}>
                            Log Round Score (Relative Par)
                          </div>

                          <div
                            style={{ marginTop: 10, display: "grid", gap: 10 }}
                          >
                            <input
                              style={input}
                              type="number"
                              min={-18}
                              max={18}
                              value={scoreDraftByCard[c.id] ?? 0}
                              onChange={(e) =>
                                setScoreDraftByCard((s) => ({
                                  ...s,
                                  [c.id]: e.target.value,
                                }))
                              }
                            />
                            <div style={{ fontSize: 12, color: COLORS.muted }}>
                              Allowed: -18 to +18
                            </div>

                            <button
                              style={button(true)}
                              onClick={() => submitCardScore(c.id)}
                            >
                              Submit Score
                            </button>

                            {!!submitMsgByCard[c.id] && (
                              <div
                                style={{
                                  fontWeight: 900,
                                  color: COLORS.green,
                                  marginTop: 4,
                                }}
                              >
                                {submitMsgByCard[c.id]}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Admin (bottom) */}
        <div style={{ marginTop: 14, ...cardStyle }}>
          <div
            style={sectionTitleRow}
            onClick={() => setAdminExpanded((v) => !v)}
          >
            <div style={{ fontWeight: 1000, fontSize: 18, color: COLORS.navy }}>
              Admin
            </div>
            <div style={{ color: COLORS.muted, fontWeight: 800 }}>
              {adminExpanded ? "Hide" : "Show"}
            </div>
          </div>

          {adminExpanded && (
            <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
              {!adminUnlocked ? (
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ color: COLORS.muted }}>
                    Enter password to unlock admin tools.
                  </div>
                  <input
                    style={input}
                    type="password"
                    placeholder="Admin password"
                    value={adminPw}
                    onChange={(e) => setAdminPw(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") tryUnlockAdmin();
                    }}
                  />
                  <button style={button(true)} onClick={tryUnlockAdmin}>
                    Unlock
                  </button>
                </div>
              ) : (
                <>
                  {/* Settings */}
                  <div style={{ ...cardStyle, padding: 12 }}>
                    <div style={{ fontWeight: 1000, color: COLORS.navy }}>
                      Settings
                    </div>

                    <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                      <div
                        style={{ display: "flex", gap: 10, flexWrap: "wrap" }}
                      >
                        <button
                          style={{
                            ...button(formatChoice === "seated"),
                            background:
                              formatChoice === "seated"
                                ? COLORS.orange
                                : "#fff",
                            flex: 1,
                            minWidth: 220,
                          }}
                          onClick={() => setFormatChoice("seated")}
                        >
                          Seated Doubles (A/B)
                        </button>
                        <button
                          style={{
                            ...button(formatChoice === "random"),
                            background:
                              formatChoice === "random"
                                ? COLORS.orange
                                : "#fff",
                            flex: 1,
                            minWidth: 220,
                          }}
                          onClick={() => setFormatChoice("random")}
                        >
                          Random Doubles
                        </button>
                      </div>

                      <div
                        style={{ display: "flex", gap: 10, flexWrap: "wrap" }}
                      >
                        <button
                          style={{
                            ...button(caliMode === "random"),
                            background:
                              caliMode === "random" ? COLORS.orange : "#fff",
                            flex: 1,
                            minWidth: 220,
                          }}
                          onClick={() => setCaliMode("random")}
                        >
                          Cali: Random (if odd)
                        </button>
                        <button
                          style={{
                            ...button(caliMode === "manual"),
                            background:
                              caliMode === "manual" ? COLORS.orange : "#fff",
                            flex: 1,
                            minWidth: 220,
                          }}
                          onClick={() => setCaliMode("manual")}
                        >
                          Cali: Admin selects (if odd)
                        </button>
                      </div>

                      {caliMode === "manual" && (
                        <div style={{ display: "grid", gap: 8 }}>
                          <div style={{ fontSize: 12, color: COLORS.muted }}>
                            Only used if there is an odd number of checked-in
                            players. (For seated doubles, selection should come
                            from the odd pool.)
                          </div>
                          <select
                            style={input}
                            value={manualCaliId}
                            onChange={(e) => setManualCaliId(e.target.value)}
                          >
                            <option value="">
                              Select Cali player (optional)
                            </option>
                            {checkins.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                                {p.pool ? ` (${p.pool})` : ""}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      <textarea
                        style={{ ...input, minHeight: 90, resize: "vertical" }}
                        placeholder='Layout note (ex: "Front 9, skip hole 7" or "Shotgun start, hole gap")'
                        value={layoutNote}
                        onChange={(e) => setLayoutNote(e.target.value)}
                      />

                      <button style={button(true)} onClick={saveAdminSettings}>
                        Save Settings
                      </button>
                    </div>
                  </div>

                  {/* Late player */}
                  {started && (
                    <div style={{ ...cardStyle, padding: 12 }}>
                      <div style={{ fontWeight: 1000, color: COLORS.navy }}>
                        Add Late Player
                      </div>
                      <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                        <input
                          style={input}
                          placeholder="Late player name"
                          value={lateName}
                          onChange={(e) => setLateName(e.target.value)}
                        />

                        {isSeated && (
                          <div style={{ display: "flex", gap: 10 }}>
                            <button
                              style={{
                                ...button(latePool === "A"),
                                flex: 1,
                                background:
                                  latePool === "A" ? COLORS.orange : "#fff",
                              }}
                              onClick={() => setLatePool("A")}
                            >
                              Pool A
                            </button>
                            <button
                              style={{
                                ...button(latePool === "B"),
                                flex: 1,
                                background:
                                  latePool === "B" ? COLORS.orange : "#fff",
                              }}
                              onClick={() => setLatePool("B")}
                            >
                              Pool B
                            </button>
                          </div>
                        )}

                        <div style={{ display: "grid", gap: 6 }}>
                          <div style={{ fontSize: 12, color: COLORS.muted }}>
                            Late player behavior:
                            <ul style={{ margin: "6px 0 0 18px" }}>
                              <li>
                                If there’s an unpaired Cali already on a card,
                                the late player becomes their teammate.
                              </li>
                              <li>
                                Otherwise, the late player is added as a Cali on
                                the selected card.
                              </li>
                            </ul>
                          </div>

                          <select
                            style={input}
                            value={lateCardId}
                            onChange={(e) => setLateCardId(e.target.value)}
                          >
                            <option value="">Select card…</option>
                            {cards.map((c, i) => (
                              <option key={c.id} value={c.id}>
                                Card {i + 1} (Start Hole {c.startHole})
                              </option>
                            ))}
                          </select>
                        </div>

                        <button style={button(true)} onClick={addLatePlayer}>
                          Add Late Player
                        </button>

                        {!!lateMsg && (
                          <div style={{ fontWeight: 900, color: COLORS.green }}>
                            {lateMsg}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Edit holes */}
                  {started && cards.length > 0 && (
                    <div style={{ ...cardStyle, padding: 12 }}>
                      <div style={{ fontWeight: 1000, color: COLORS.navy }}>
                        Starting Holes
                      </div>

                      {!editHolesOpen ? (
                        <button
                          style={{ ...button(true), marginTop: 10 }}
                          onClick={() => {
                            const init = {};
                            cards.forEach((c) => (init[c.id] = c.startHole));
                            setHoleEdits(init);
                            setEditHolesOpen(true);
                          }}
                        >
                          Edit Starting Holes
                        </button>
                      ) : (
                        <div
                          style={{ marginTop: 10, display: "grid", gap: 10 }}
                        >
                          {cards.map((c, i) => (
                            <div
                              key={c.id}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                              }}
                            >
                              <div style={{ width: 120, fontWeight: 900 }}>
                                Card {i + 1}
                              </div>
                              <input
                                style={{ ...input, maxWidth: 140 }}
                                type="number"
                                min={1}
                                max={18}
                                value={holeEdits[c.id] ?? c.startHole}
                                onChange={(e) =>
                                  setHoleEdits((h) => ({
                                    ...h,
                                    [c.id]: e.target.value,
                                  }))
                                }
                              />
                            </div>
                          ))}

                          <div style={{ display: "flex", gap: 10 }}>
                            <button
                              style={button(true)}
                              onClick={saveStartingHoleEdits}
                            >
                              Save
                            </button>
                            <button
                              style={button(false)}
                              onClick={() => setEditHolesOpen(false)}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Bottom big buttons */}
                  <div
                    style={{
                      display: "flex",
                      gap: 12,
                      flexWrap: "wrap",
                      justifyContent: "center",
                      marginTop: 4,
                    }}
                  >
                    <button
                      style={bigAdminButton(false)}
                      onClick={makeTeamsAndCards}
                      disabled={checkins.length < 4 || started}
                      title={
                        started
                          ? "Round already started"
                          : checkins.length < 4
                          ? "Need at least 4 players checked in"
                          : ""
                      }
                    >
                      Make Teams & Cards
                    </button>

                    <button
                      style={bigAdminButton(false)}
                      onClick={() => {
                        const init = {};
                        cards.forEach((c) => (init[c.id] = c.startHole));
                        setHoleEdits(init);
                        setEditHolesOpen(true);
                      }}
                      disabled={!started || cards.length === 0}
                    >
                      Edit Starting Holes
                    </button>

                    <button
                      style={bigAdminButton(true)}
                      onClick={eraseDoublesInfo}
                    >
                      Erase Doubles Information
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div style={{ height: 30 }} />
      </div>
    </div>
  );
}
