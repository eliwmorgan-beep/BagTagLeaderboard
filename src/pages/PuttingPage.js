// src/pages/PuttingPage.js
import React, { useEffect, useMemo, useState } from "react";
import { useParams, NavLink } from "react-router-dom";
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

const ADMIN_PASSWORD = "Pescado!";
const APP_VERSION = "v1.8.5";

// ---------- utils ----------
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function clampInt(n, min, max) {
  const x = Number(n);
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function isMissing(v) {
  return v === undefined || v === null || v === "";
}

export default function PuttingPage() {
  const { leagueId } = useParams();

  // --- Palette / look ---
  const COLORS = {
    navy: "#1b1f5a",
    blueLight: "#e6f3ff",
    orange: "#f4a83a",
    green: "#15803d",
    red: "#cc0000",
    text: "#0b1220",
    border: "#dbe9ff",
    panel: "#ffffff",
    soft: "#f6fbff",
  };

  const inputStyle = {
    padding: "10px 12px",
    borderRadius: 12,
    border: `1px solid ${COLORS.border}`,
    outline: "none",
    fontSize: 14,
  };

  const buttonStyle = {
    padding: "10px 14px",
    borderRadius: 12,
    border: `1px solid ${COLORS.border}`,
    background: COLORS.orange,
    color: "#1a1a1a",
    fontWeight: 800,
    cursor: "pointer",
  };

  const smallButtonStyle = {
    ...buttonStyle,
    padding: "8px 12px",
  };

  const pillRowStyle = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  };

  const pillStyle = (active) => ({
    ...smallButtonStyle,
    width: "100%",
    background: active ? COLORS.navy : "#fff",
    color: active ? "white" : COLORS.navy,
    border: `1px solid ${COLORS.navy}`,
    fontWeight: 900,
  });

  // ✅ Firestore ref
  const leagueRef = useMemo(() => {
    if (!leagueId) return null;
    return doc(db, "leagues", leagueId);
  }, [leagueId]);

  // ---------- Firestore state ----------
  const [putting, setPutting] = useState({
    settings: {
      // general
      rounds: 3, // number of rounds (1-5)
      finalized: false,

      // format controls
      formatMode: "sequential", // "simultaneous" | "sequential"
      poolMode: "split", // "split" | "combined"

      // sequential workflow controls
      formatLocked: false, // admin locks format before check-in begins
      checkInLocked: false, // admin locks check-in when ready

      // (legacy / simultaneous support; kept for compatibility)
      stations: 1, // up to 18
    },

    // sequential model
    players: [], // [{id,name,pool}]
    cards: [], // [{id,name,playerIds:[]}]
    // roundScores[round][cardId][playerId] = number (0..50)
    roundScores: {},
    // cardRoundSubmitted[cardId] = number (highest round submitted, 0 if none)
    cardRoundSubmitted: {},

    // admin adjustments (optional; still useful)
    adjustments: {}, // {playerId: number}
  });

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  // UI state
  const [setupOpen, setSetupOpen] = useState(false);
  const [checkinOpen, setCheckinOpen] = useState(true);
  const [cardsOpen, setCardsOpen] = useState(true);
  const [leaderboardsOpen, setLeaderboardsOpen] = useState(false);

  // add player UI
  const [name, setName] = useState("");
  const [pool, setPool] = useState("A");

  // create card UI
  const [cardName, setCardName] = useState("");
  const [selectedForNewCard, setSelectedForNewCard] = useState([]);

  // per-card expanded
  const [openCards, setOpenCards] = useState({}); // {cardId: boolean}

  // ✅ admin unlock window (device/tab specific)
  const [adminOkUntil, setAdminOkUntil] = useState(0);

  function requireAdmin(fn) {
    const now = Date.now();
    if (now < adminOkUntil) return fn();

    const pw = window.prompt("Admin password:");
    if (pw !== ADMIN_PASSWORD) {
      alert("Wrong password.");
      return;
    }
    setAdminOkUntil(now + 10 * 60 * 1000);
    return fn();
  }

  // -------- derived ----------
  const settings = putting.settings || {};
  const totalRounds = clampInt(settings.rounds ?? 3, 1, 5);
  const finalized = !!settings.finalized;

  const formatMode =
    settings.formatMode === "simultaneous" ? "simultaneous" : "sequential";

  const poolMode = settings.poolMode === "combined" ? "combined" : "split";
  const poolsEnabled = poolMode === "split";

  const formatLocked = !!settings.formatLocked;
  const checkInLocked = !!settings.checkInLocked;

  const players = Array.isArray(putting.players) ? putting.players : [];
  const cards = Array.isArray(putting.cards) ? putting.cards : [];

  const roundScores =
    putting.roundScores && typeof putting.roundScores === "object"
      ? putting.roundScores
      : {};

  const cardRoundSubmitted =
    putting.cardRoundSubmitted && typeof putting.cardRoundSubmitted === "object"
      ? putting.cardRoundSubmitted
      : {};

  const adjustments =
    putting.adjustments && typeof putting.adjustments === "object"
      ? putting.adjustments
      : {};

  const playerById = useMemo(() => {
    const map = {};
    players.forEach((p) => (map[p.id] = p));
    return map;
  }, [players]);

  const assignedPlayerIds = useMemo(() => {
    const set = new Set();
    cards.forEach((c) => (c.playerIds || []).forEach((pid) => set.add(pid)));
    return set;
  }, [cards]);

  const unassignedPlayers = useMemo(() => {
    return players.filter((p) => !assignedPlayerIds.has(p.id));
  }, [players, assignedPlayerIds]);

  // -------- Firestore subscribe + bootstrap --------
  useEffect(() => {
    if (!leagueRef) return;

    let unsub = () => {};
    setLoading(true);
    setLoadError("");

    (async () => {
      await ensureAnonAuth();

      const snap = await getDoc(leagueRef);
      if (!snap.exists()) {
        await setDoc(leagueRef, {
          displayName: leagueId,
          puttingLeague: {
            settings: {
              rounds: 3,
              finalized: false,
              formatMode: "sequential",
              poolMode: "split",
              formatLocked: false,
              checkInLocked: false,
              stations: 1,
            },
            players: [],
            cards: [],
            roundScores: {},
            cardRoundSubmitted: {},
            adjustments: {},
          },
        });
      }

      unsub = onSnapshot(
        leagueRef,
        (s) => {
          const data = s.data() || {};
          const pl = data.puttingLeague || {};

          const safe = {
            settings: {
              rounds: 3,
              finalized: false,
              formatMode: "sequential",
              poolMode: "split",
              formatLocked: false,
              checkInLocked: false,
              stations: 1,
              ...(pl.settings || {}),
            },
            players: Array.isArray(pl.players) ? pl.players : [],
            cards: Array.isArray(pl.cards) ? pl.cards : [],
            roundScores:
              pl.roundScores && typeof pl.roundScores === "object"
                ? pl.roundScores
                : {},
            cardRoundSubmitted:
              pl.cardRoundSubmitted && typeof pl.cardRoundSubmitted === "object"
                ? pl.cardRoundSubmitted
                : {},
            adjustments:
              pl.adjustments && typeof pl.adjustments === "object"
                ? pl.adjustments
                : {},
          };

          setPutting(safe);
          setLoading(false);
        },
        (err) => {
          console.error(err);
          setLoadError("Could not load this league.");
          setLoading(false);
        }
      );
    })().catch((e) => {
      console.error(e);
      setLoadError("Could not load this league.");
      setLoading(false);
    });

    return () => unsub();
  }, [leagueRef, leagueId]);

  // -------- Firestore update helpers --------
  async function updatePutting(patch) {
    if (!leagueRef) return;
    await updateDoc(leagueRef, {
      puttingLeague: {
        ...putting,
        ...patch,
      },
    });
  }

  async function updatePuttingDot(dotPath, value) {
    if (!leagueRef) return;
    await updateDoc(leagueRef, {
      [`puttingLeague.${dotPath}`]: value,
    });
  }

  // --------- Admin actions (sequential workflow) ---------
  async function lockFormatAndOpenCheckIn() {
    if (finalized) return;

    await requireAdmin(async () => {
      if (formatLocked) return;

      // lock format, allow check-in (unlocked)
      await updatePutting({
        settings: {
          ...settings,
          formatLocked: true,
          checkInLocked: false,
        },
      });

      setSetupOpen(false);
      setCheckinOpen(true);
      window.scrollTo(0, 0);
    });
  }

  async function lockCheckIn() {
    if (finalized) return;
    if (!formatLocked) {
      alert("Lock the format first (Open Check-In).");
      return;
    }

    await requireAdmin(async () => {
      if (checkInLocked) return;
      await updatePutting({
        settings: {
          ...settings,
          checkInLocked: true,
        },
      });
    });
  }

  async function finalizeLeaderboard() {
    if (finalized) return;

    await requireAdmin(async () => {
      const ok = window.confirm(
        "Finalize leaderboard?\n\nThis will lock the leaderboard and prevent any more score submissions."
      );
      if (!ok) return;

      await updatePutting({
        settings: {
          ...settings,
          finalized: true,
          checkInLocked: true,
        },
      });
    });
  }

  async function resetPuttingLeague() {
    await requireAdmin(async () => {
      const ok = window.confirm(
        "Reset PUTTING league only?\n\nThis clears players, cards, round scores, and settings for the putting league."
      );
      if (!ok) return;

      await updateDoc(leagueRef, {
        puttingLeague: {
          settings: {
            rounds: 3,
            finalized: false,
            formatMode: "sequential",
            poolMode: "split",
            formatLocked: false,
            checkInLocked: false,
            stations: 1,
          },
          players: [],
          cards: [],
          roundScores: {},
          cardRoundSubmitted: {},
          adjustments: {},
        },
      });

      setName("");
      setPool("A");
      setCardName("");
      setSelectedForNewCard([]);
      setOpenCards({});
      setSetupOpen(false);
      setCheckinOpen(true);
      setCardsOpen(true);
      setLeaderboardsOpen(false);
    });
  }

  // -------- Check-in ----------
  async function addPlayer() {
    if (finalized) return;
    if (!formatLocked) {
      alert(
        'Format is not locked yet. Use "Lock Format and Open Check-In" first.'
      );
      return;
    }
    if (checkInLocked) return;

    const n = (name || "").trim();
    if (!n) return;

    const exists = players.some(
      (p) => (p.name || "").trim().toLowerCase() === n.toLowerCase()
    );
    if (exists) {
      alert("That name is already checked in.");
      return;
    }

    const newPlayer = {
      id: uid(),
      name: n,
      pool: poolsEnabled ? pool || "A" : "A",
    };

    await updatePutting({ players: [...players, newPlayer] });
    setName("");
    setPool("A");
  }

  // -------- Cards (sequential) ----------
  function toggleSelectNewCard(pid) {
    setSelectedForNewCard((prev) =>
      prev.includes(pid) ? prev.filter((x) => x !== pid) : [...prev, pid]
    );
  }

  async function createCardSequential() {
    if (finalized) return;
    if (!formatLocked) {
      alert("Lock the format first (Open Check-In).");
      return;
    }

    if (selectedForNewCard.length < 2) {
      alert("Select at least 2 players to form a card.");
      return;
    }
    if (selectedForNewCard.length > 4) {
      alert("Max 4 players per card.");
      return;
    }

    // ensure all selected are unassigned
    const invalid = selectedForNewCard.some((pid) =>
      assignedPlayerIds.has(pid)
    );
    if (invalid) {
      alert("One or more selected players are already assigned to a card.");
      return;
    }

    const newCard = {
      id: uid(),
      name: (cardName || "").trim() || `Card ${cards.length + 1}`,
      playerIds: [...selectedForNewCard],
    };

    await updatePutting({
      cards: [...cards, newCard],
      cardRoundSubmitted: {
        ...cardRoundSubmitted,
        [newCard.id]: 0,
      },
    });

    setSelectedForNewCard([]);
    setCardName("");
    setOpenCards((prev) => ({ ...prev, [newCard.id]: true }));
  }

  function cardSubmittedRound(cardId) {
    const n = Number(cardRoundSubmitted?.[cardId] ?? 0);
    return Number.isNaN(n) ? 0 : n;
  }

  function nextRoundForCard(cardId) {
    const done = cardSubmittedRound(cardId);
    return Math.min(done + 1, totalRounds);
  }

  function isCardComplete(cardId) {
    return cardSubmittedRound(cardId) >= totalRounds;
  }

  function canEditCardPlayers(cardId) {
    // ✅ once round 1 is submitted for that card, players cannot be added/moved
    return cardSubmittedRound(cardId) < 1;
  }

  // roundScores helpers:
  function getRoundScore(roundNum, cardId, playerId) {
    const r = roundScores?.[String(roundNum)] || {};
    const c = r?.[cardId] || {};
    const raw = c?.[playerId];
    if (isMissing(raw)) return null;
    const n = Number(raw);
    return Number.isNaN(n) ? null : n;
  }

  async function setRoundScore(roundNum, cardId, playerId, value) {
    if (finalized) return;

    // lock past submitted rounds for this card
    if (roundNum <= cardSubmittedRound(cardId)) return;

    const path = `puttingLeague.roundScores.${String(
      roundNum
    )}.${cardId}.${playerId}`;

    if (isMissing(value)) {
      await updateDoc(leagueRef, { [path]: deleteField() });
      return;
    }

    const val = clampInt(value, 0, 50);
    await updateDoc(leagueRef, { [path]: val });
  }

  function isRoundFilledForCard(roundNum, card) {
    const pids = card?.playerIds || [];
    if (!pids.length) return false;

    for (const pid of pids) {
      const v = getRoundScore(roundNum, card.id, pid);
      if (v === null) return false; // 0 is valid
    }
    return true;
  }

  async function submitNextRoundForCard(cardId) {
    if (finalized) return;

    const card = cards.find((c) => c.id === cardId);
    if (!card) return;

    const done = cardSubmittedRound(cardId);
    if (done >= totalRounds) return;

    const roundNum = done + 1;
    if (!isRoundFilledForCard(roundNum, card)) {
      alert(`Missing scores for Round ${roundNum}. Fill all players first.`);
      return;
    }

    // mark submitted
    await updatePutting({
      cardRoundSubmitted: {
        ...cardRoundSubmitted,
        [cardId]: roundNum,
      },
    });
  }

  // -------- Leaderboard totals (only count submitted rounds) ----------
  function submittedTotalForPlayer(pid) {
    let total = 0;

    // for each round, add score ONLY if player's card has submitted that round
    for (let r = 1; r <= totalRounds; r++) {
      const roundObj = roundScores?.[String(r)] || {};
      // find card containing player
      const card = cards.find((c) => (c.playerIds || []).includes(pid));
      if (!card) continue;

      const submittedUpTo = cardSubmittedRound(card.id);
      if (submittedUpTo < r) continue;

      const cardScores = roundObj?.[card.id] || {};
      const raw = cardScores?.[pid];
      const n = Number(raw);
      if (Number.isNaN(n)) continue; // if missing somehow, ignore
      total += n;
    }

    const adj = Number(adjustments?.[pid] ?? 0) || 0;
    return total + adj;
  }

  const leaderboardGroups = useMemo(() => {
    const groups = poolsEnabled ? { A: [], B: [], C: [] } : { ALL: [] };

    players.forEach((p) => {
      const row = {
        id: p.id,
        name: p.name,
        pool: p.pool,
        total: submittedTotalForPlayer(p.id),
        adj: Number(adjustments?.[p.id] ?? 0) || 0,
      };

      if (!poolsEnabled) groups.ALL.push(row);
      else if (p.pool === "B") groups.B.push(row);
      else if (p.pool === "C") groups.C.push(row);
      else groups.A.push(row);
    });

    Object.keys(groups).forEach((k) =>
      groups[k].sort((a, b) => b.total - a.total)
    );

    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    players,
    cards,
    roundScores,
    cardRoundSubmitted,
    adjustments,
    poolsEnabled,
    totalRounds,
  ]);

  function computeTiedRanks(rowsSorted) {
    const ranks = [];
    let prevTotal = null;
    let prevRank = 1;

    rowsSorted.forEach((r, idx) => {
      if (idx === 0) {
        ranks.push(1);
        prevTotal = r.total;
        prevRank = 1;
        return;
      }
      if (r.total === prevTotal) ranks.push(prevRank);
      else {
        const rank = idx + 1;
        ranks.push(rank);
        prevRank = rank;
        prevTotal = r.total;
      }
    });

    return ranks;
  }

  // -------- Pool mode + format mode changes (pre-lock only) ----------
  async function setFormatMode(next) {
    if (finalized) return;
    if (formatLocked) {
      alert("Format is locked.");
      return;
    }
    await updatePutting({ settings: { ...settings, formatMode: next } });
  }

  async function setPoolMode(next) {
    if (finalized) return;
    if (formatLocked) {
      alert("Pool mode is locked.");
      return;
    }
    await updatePutting({ settings: { ...settings, poolMode: next } });
  }

  // -------- Guards ----------
  if (!leagueId) {
    return (
      <div>
        <Header />
        <div style={{ padding: 16, maxWidth: 900, margin: "0 auto" }}>
          <h2>Putting League</h2>
          <p style={{ opacity: 0.8 }}>
            No league selected. Go back and enter a league code.
          </p>
          <NavLink to="/" style={{ fontWeight: 900 }}>
            ← Back to League Search
          </NavLink>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <Header />
        <div style={{ padding: 16, maxWidth: 900, margin: "0 auto" }}>
          <p>Loading league…</p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        <Header />
        <div style={{ padding: 16, maxWidth: 900, margin: "0 auto" }}>
          <p style={{ color: "#b00020", fontWeight: 900 }}>{loadError}</p>
          <NavLink to="/" style={{ fontWeight: 900 }}>
            ← Back to League Search
          </NavLink>
        </div>
      </div>
    );
  }

  const leaderboardKeys = poolsEnabled ? ["A", "B", "C"] : ["ALL"];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: `linear-gradient(180deg, ${COLORS.blueLight} 0%, #ffffff 60%)`,
        display: "flex",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 760 }}>
        <div
          style={{
            textAlign: "center",
            background: COLORS.panel,
            borderRadius: 18,
            padding: 26,
            border: `2px solid ${COLORS.navy}`,
            boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
          }}
        >
          <Header />

          <div
            style={{
              marginTop: 10,
              fontSize: 12,
              opacity: 0.7,
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span>
              League: <strong>{leagueId}</strong>
            </span>
            <span style={{ opacity: 0.6 }}>•</span>
            <NavLink
              to={`/league/${encodeURIComponent(leagueId)}`}
              style={{
                fontWeight: 900,
                color: COLORS.navy,
                textDecoration: "none",
              }}
            >
              Back to League
            </NavLink>
          </div>

          <div
            style={{
              color: COLORS.green,
              marginTop: 14,
              marginBottom: 12,
              fontWeight: 900,
            }}
          >
            Putting League{" "}
            <span style={{ color: COLORS.navy }}>
              —{" "}
              {formatMode === "sequential"
                ? "Sequential Mode"
                : "Simultaneous Mode"}
            </span>
            {finalized ? (
              <div style={{ marginTop: 6, color: COLORS.red, fontWeight: 900 }}>
                FINALIZED (locked)
              </div>
            ) : null}
          </div>

          {/* ADMIN TOOLS */}
          <div
            style={{
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              background: COLORS.soft,
              padding: 12,
              textAlign: "left",
              marginBottom: 12,
            }}
          >
            <div
              onClick={() => setSetupOpen((v) => !v)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 900, color: COLORS.navy }}>
                Admin Tools
              </div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {setupOpen ? "Tap to collapse" : "Tap to expand"}
              </div>
            </div>

            {setupOpen && (
              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                {/* FORMAT MODE */}
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 900,
                      color: COLORS.navy,
                      marginBottom: 6,
                    }}
                  >
                    Station Format
                  </div>
                  <div style={pillRowStyle}>
                    <button
                      disabled={formatLocked || finalized}
                      onClick={() => setFormatMode("simultaneous")}
                      style={pillStyle(formatMode === "simultaneous")}
                    >
                      Simultaneous
                    </button>
                    <button
                      disabled={formatLocked || finalized}
                      onClick={() => setFormatMode("sequential")}
                      style={pillStyle(formatMode === "sequential")}
                    >
                      Sequential
                    </button>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
                    {formatLocked || finalized
                      ? "Format is locked."
                      : "Choose before locking format."}
                  </div>
                </div>

                {/* POOL MODE */}
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 900,
                      color: COLORS.navy,
                      marginBottom: 6,
                    }}
                  >
                    Pool Mode
                  </div>
                  <div style={pillRowStyle}>
                    <button
                      disabled={formatLocked || finalized}
                      onClick={() => setPoolMode("split")}
                      style={pillStyle(poolMode === "split")}
                    >
                      Split Pool
                    </button>
                    <button
                      disabled={formatLocked || finalized}
                      onClick={() => setPoolMode("combined")}
                      style={pillStyle(poolMode === "combined")}
                    >
                      Combined Pool
                    </button>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
                    {poolMode === "combined"
                      ? "Combined Pool = one leaderboard."
                      : "Split Pool = A/B/C leaderboards."}
                  </div>
                </div>

                {/* ROUNDS */}
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 900,
                      color: COLORS.navy,
                      marginBottom: 6,
                    }}
                  >
                    Number of Rounds
                  </div>
                  <select
                    value={totalRounds}
                    disabled={formatLocked || finalized}
                    onChange={(e) =>
                      updatePutting({
                        settings: {
                          ...settings,
                          rounds: Number(e.target.value),
                        },
                      })
                    }
                    style={{ ...inputStyle, width: "100%", background: "#fff" }}
                  >
                    {Array.from({ length: 5 }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>

                {/* LOCK FORMAT / OPEN CHECK-IN */}
                <button
                  onClick={lockFormatAndOpenCheckIn}
                  disabled={formatLocked || finalized}
                  style={{
                    ...buttonStyle,
                    width: "100%",
                    background: formatLocked ? "#ddd" : COLORS.green,
                    color: formatLocked ? "#444" : "white",
                    border: `1px solid ${formatLocked ? "#ddd" : COLORS.green}`,
                    fontWeight: 900,
                  }}
                  title="Requires admin password. Locks format and enables check-in."
                >
                  {formatLocked
                    ? "Format Locked"
                    : "Lock Format and Open Check-In"}
                </button>

                {/* LOCK CHECK-IN */}
                <button
                  onClick={lockCheckIn}
                  disabled={!formatLocked || checkInLocked || finalized}
                  style={{
                    ...buttonStyle,
                    width: "100%",
                    background: checkInLocked ? "#ddd" : COLORS.navy,
                    color: checkInLocked ? "#444" : "white",
                    border: `1px solid ${checkInLocked ? "#ddd" : COLORS.navy}`,
                    fontWeight: 900,
                  }}
                  title="Requires admin password. Prevents any new players from checking in."
                >
                  {checkInLocked ? "Check-In Locked" : "Lock Check-In"}
                </button>

                {/* FINALIZE */}
                <button
                  onClick={finalizeLeaderboard}
                  disabled={finalized}
                  style={{
                    ...buttonStyle,
                    width: "100%",
                    background: COLORS.red,
                    color: "white",
                    border: `1px solid ${COLORS.red}`,
                    fontWeight: 900,
                  }}
                  title="Requires admin password. Locks everything."
                >
                  Finalize Leaderboard (Lock All)
                </button>

                <button
                  onClick={resetPuttingLeague}
                  style={{
                    ...smallButtonStyle,
                    width: "100%",
                    background: "#fff",
                    border: `1px solid ${COLORS.border}`,
                    fontWeight: 900,
                  }}
                  title="Requires admin password."
                >
                  Reset Putting League
                </button>
              </div>
            )}
          </div>

          {/* CHECK-IN (ALWAYS PRESENT / COLLAPSIBLE) */}
          <div
            style={{
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              background: COLORS.soft,
              padding: 12,
              textAlign: "left",
              marginBottom: 12,
            }}
          >
            <div
              onClick={() => setCheckinOpen((v) => !v)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 900, color: COLORS.navy }}>
                Player Check-In ({players.length})
              </div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {checkinOpen ? "Tap to collapse" : "Tap to expand"}
              </div>
            </div>

            {checkinOpen && (
              <div style={{ marginTop: 10 }}>
                {!formatLocked ? (
                  <div
                    style={{
                      fontSize: 12,
                      opacity: 0.8,
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: `1px solid ${COLORS.border}`,
                      background: "#fff",
                      marginBottom: 10,
                    }}
                  >
                    Check-in is closed until the admin clicks{" "}
                    <strong>Lock Format and Open Check-In</strong>.
                  </div>
                ) : null}

                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <input
                    placeholder="Player name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    style={{ ...inputStyle, width: 240 }}
                    disabled={finalized || !formatLocked || checkInLocked}
                  />

                  {poolsEnabled ? (
                    <select
                      value={pool}
                      onChange={(e) => setPool(e.target.value)}
                      style={{ ...inputStyle, width: 140, background: "#fff" }}
                      disabled={finalized || !formatLocked || checkInLocked}
                    >
                      <option value="A">A Pool</option>
                      <option value="B">B Pool</option>
                      <option value="C">C Pool</option>
                    </select>
                  ) : null}

                  <button
                    onClick={addPlayer}
                    style={{
                      ...smallButtonStyle,
                      background: COLORS.green,
                      color: "white",
                      border: `1px solid ${COLORS.green}`,
                    }}
                    disabled={finalized || !formatLocked || checkInLocked}
                    title={
                      !formatLocked
                        ? "Admin must open check-in first."
                        : checkInLocked
                        ? "Check-in is locked."
                        : "Add player"
                    }
                  >
                    Add
                  </button>
                </div>

                {!poolsEnabled && (
                  <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
                    Pool Mode is <strong>Combined</strong> — only player names
                    are needed.
                  </div>
                )}

                {checkInLocked ? (
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      color: COLORS.red,
                      fontWeight: 900,
                    }}
                  >
                    Check-In Locked
                  </div>
                ) : null}

                {players.length ? (
                  <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                    {players.map((p) => (
                      <div
                        key={p.id}
                        style={{
                          padding: "10px 12px",
                          borderRadius: 12,
                          border: `1px solid ${COLORS.border}`,
                          background: "#fff",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <div style={{ fontWeight: 900, color: COLORS.text }}>
                          {p.name}
                        </div>
                        <div
                          style={{
                            display: "flex",
                            gap: 10,
                            alignItems: "center",
                          }}
                        >
                          {assignedPlayerIds.has(p.id) ? (
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 900,
                                color: COLORS.green,
                              }}
                            >
                              Assigned
                            </span>
                          ) : (
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 900,
                                color: COLORS.navy,
                                opacity: 0.75,
                              }}
                            >
                              Unassigned
                            </span>
                          )}
                          {poolsEnabled ? (
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: 900,
                                color: COLORS.navy,
                              }}
                            >
                              {p.pool === "B"
                                ? "B Pool"
                                : p.pool === "C"
                                ? "C Pool"
                                : "A Pool"}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                    Add players as they arrive.
                  </div>
                )}

                {/* ✅ Sequential card forming (simple) */}
                <div
                  style={{
                    marginTop: 12,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 12,
                    background: "#fff",
                    padding: 10,
                  }}
                >
                  <div
                    style={{
                      fontWeight: 900,
                      color: COLORS.navy,
                      marginBottom: 8,
                    }}
                  >
                    Form a Card (Sequential Mode)
                  </div>

                  <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
                    Select <strong>2–4</strong> unassigned players, then create
                    a card.
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      flexWrap: "wrap",
                      alignItems: "center",
                      marginBottom: 10,
                    }}
                  >
                    <input
                      placeholder="Card name (optional)"
                      value={cardName}
                      onChange={(e) => setCardName(e.target.value)}
                      style={{ ...inputStyle, width: 240 }}
                      disabled={finalized || !formatLocked}
                    />

                    <button
                      onClick={createCardSequential}
                      style={{
                        ...smallButtonStyle,
                        background: COLORS.navy,
                        color: "white",
                        border: `1px solid ${COLORS.navy}`,
                      }}
                      disabled={
                        finalized ||
                        !formatLocked ||
                        selectedForNewCard.length < 2 ||
                        selectedForNewCard.length > 4
                      }
                      title={
                        !formatLocked
                          ? "Admin must open check-in first."
                          : "Create card"
                      }
                    >
                      Create Card
                    </button>

                    <div style={{ fontSize: 12, opacity: 0.75 }}>
                      Selected: <strong>{selectedForNewCard.length}</strong> / 4
                    </div>
                  </div>

                  {unassignedPlayers.length === 0 ? (
                    <div style={{ fontSize: 12, opacity: 0.75 }}>
                      No unassigned players available.
                    </div>
                  ) : (
                    <div style={{ display: "grid", gap: 8 }}>
                      {unassignedPlayers.map((p) => (
                        <label
                          key={p.id}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 10,
                            padding: "10px 12px",
                            borderRadius: 12,
                            border: `1px solid ${COLORS.border}`,
                            background: COLORS.soft,
                            cursor: finalized ? "not-allowed" : "pointer",
                            opacity: finalized ? 0.6 : 1,
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={selectedForNewCard.includes(p.id)}
                              disabled={
                                finalized || !formatLocked || checkInLocked
                              }
                              onChange={() => toggleSelectNewCard(p.id)}
                            />
                            <div style={{ fontWeight: 900 }}>{p.name}</div>
                          </div>

                          {poolsEnabled ? (
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: 900,
                                color: COLORS.navy,
                              }}
                            >
                              {p.pool === "B"
                                ? "B Pool"
                                : p.pool === "C"
                                ? "C Pool"
                                : "A Pool"}
                            </div>
                          ) : null}
                        </label>
                      ))}
                    </div>
                  )}

                  {checkInLocked ? (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                      Check-in is locked, but you can still form cards from the
                      already checked-in players.
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>

          {/* CARDS (ALWAYS PRESENT / COLLAPSIBLE) */}
          <div
            style={{
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              background: COLORS.soft,
              padding: 12,
              textAlign: "left",
              marginBottom: 12,
            }}
          >
            <div
              onClick={() => setCardsOpen((v) => !v)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 900, color: COLORS.navy }}>
                Cards Formed ({cards.length})
              </div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {cardsOpen ? "Tap to collapse" : "Tap to expand"}
              </div>
            </div>

            {cardsOpen && (
              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                {cards.length === 0 ? (
                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    No cards yet. Use the Check-In section to form cards.
                  </div>
                ) : (
                  cards.map((c) => {
                    const open = !!openCards[c.id];
                    const submittedUpTo = cardSubmittedRound(c.id);
                    const isDone = submittedUpTo >= totalRounds;
                    const nextRound = Math.min(submittedUpTo + 1, totalRounds);

                    const cardPlayers = (c.playerIds || [])
                      .map((pid) => playerById[pid])
                      .filter(Boolean);

                    const canSubmitNext =
                      !finalized &&
                      !isDone &&
                      isRoundFilledForCard(nextRound, c);

                    return (
                      <div
                        key={c.id}
                        style={{
                          border: `1px solid ${COLORS.border}`,
                          borderRadius: 14,
                          background: "#fff",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          onClick={() =>
                            setOpenCards((prev) => ({ ...prev, [c.id]: !open }))
                          }
                          style={{
                            padding: "12px 12px",
                            cursor: "pointer",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 10,
                            background: COLORS.soft,
                          }}
                        >
                          <div style={{ fontWeight: 900, color: COLORS.navy }}>
                            {c.name}{" "}
                            <span style={{ fontSize: 12, opacity: 0.75 }}>
                              — submitted up to{" "}
                              <strong>
                                {submittedUpTo} / {totalRounds}
                              </strong>
                              {isDone ? " (complete)" : ""}
                            </span>
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.75 }}>
                            {open ? "Tap to collapse" : "Tap to expand"}
                          </div>
                        </div>

                        {open && (
                          <div style={{ padding: 12 }}>
                            <div
                              style={{
                                display: "grid",
                                gap: 8,
                                marginBottom: 12,
                              }}
                            >
                              {cardPlayers.map((p) => (
                                <div
                                  key={p.id}
                                  style={{
                                    padding: "10px 12px",
                                    borderRadius: 12,
                                    border: `1px solid ${COLORS.border}`,
                                    background: COLORS.soft,
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    gap: 10,
                                  }}
                                >
                                  <div style={{ fontWeight: 900 }}>
                                    {p.name}{" "}
                                    {poolsEnabled ? (
                                      <span
                                        style={{ fontSize: 12, opacity: 0.75 }}
                                      >
                                        (
                                        {p.pool === "B"
                                          ? "B"
                                          : p.pool === "C"
                                          ? "C"
                                          : "A"}
                                        )
                                      </span>
                                    ) : null}
                                  </div>
                                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                                    {submittedUpTo >= 1
                                      ? "Locked roster"
                                      : "Roster open"}
                                  </div>
                                </div>
                              ))}
                            </div>

                            {/* Round submission inside card */}
                            <div
                              style={{
                                border: `1px solid ${COLORS.border}`,
                                borderRadius: 12,
                                background: "#fff",
                                padding: 12,
                              }}
                            >
                              <div
                                style={{ fontWeight: 900, color: COLORS.navy }}
                              >
                                Round Submission
                              </div>

                              {finalized ? (
                                <div
                                  style={{
                                    marginTop: 8,
                                    fontSize: 12,
                                    color: COLORS.red,
                                    fontWeight: 900,
                                  }}
                                >
                                  Finalized — submissions locked.
                                </div>
                              ) : isDone ? (
                                <div
                                  style={{
                                    marginTop: 8,
                                    fontSize: 12,
                                    opacity: 0.75,
                                  }}
                                >
                                  All rounds submitted for this card.
                                </div>
                              ) : (
                                <>
                                  <div
                                    style={{
                                      marginTop: 8,
                                      fontSize: 12,
                                      opacity: 0.75,
                                    }}
                                  >
                                    Enter scores for{" "}
                                    <strong>Round {nextRound}</strong> (0–50),
                                    then submit.
                                    <br />
                                    Scores only count on the leaderboard once
                                    the card submits that round.
                                  </div>

                                  <div
                                    style={{
                                      marginTop: 10,
                                      display: "grid",
                                      gap: 8,
                                    }}
                                  >
                                    {cardPlayers.map((p) => {
                                      const val = getRoundScore(
                                        nextRound,
                                        c.id,
                                        p.id
                                      );
                                      const locked = nextRound <= submittedUpTo;

                                      return (
                                        <div
                                          key={p.id}
                                          style={{
                                            display: "grid",
                                            gridTemplateColumns: "1fr auto",
                                            alignItems: "center",
                                            gap: 10,
                                            padding: "10px 12px",
                                            borderRadius: 12,
                                            border: `1px solid ${COLORS.border}`,
                                            background: COLORS.soft,
                                            opacity: locked ? 0.7 : 1,
                                          }}
                                        >
                                          <div style={{ fontWeight: 900 }}>
                                            {p.name}
                                          </div>

                                          <select
                                            value={
                                              val === null ? "" : String(val)
                                            }
                                            disabled={locked || finalized}
                                            onChange={(e) =>
                                              setRoundScore(
                                                nextRound,
                                                c.id,
                                                p.id,
                                                e.target.value === ""
                                                  ? ""
                                                  : Number(e.target.value)
                                              )
                                            }
                                            style={{
                                              ...inputStyle,
                                              width: 110,
                                              background: "#fff",
                                              fontWeight: 900,
                                              textAlign: "center",
                                              justifySelf: "end",
                                            }}
                                          >
                                            <option value="">—</option>
                                            {Array.from(
                                              { length: 51 },
                                              (_, i) => i
                                            ).map((n) => (
                                              <option key={n} value={n}>
                                                {n}
                                              </option>
                                            ))}
                                          </select>
                                        </div>
                                      );
                                    })}
                                  </div>

                                  <button
                                    onClick={() => submitNextRoundForCard(c.id)}
                                    disabled={!canSubmitNext}
                                    style={{
                                      ...buttonStyle,
                                      width: "100%",
                                      marginTop: 12,
                                      background: canSubmitNext
                                        ? COLORS.green
                                        : "#ddd",
                                      color: canSubmitNext ? "white" : "#444",
                                      border: `1px solid ${
                                        canSubmitNext ? COLORS.green : "#ddd"
                                      }`,
                                      fontWeight: 900,
                                    }}
                                  >
                                    {nextRound === totalRounds
                                      ? `Submit Final Round Scores (Round ${nextRound})`
                                      : `Submit Round ${nextRound} Scores`}
                                  </button>

                                  {submittedUpTo >= 1 ? (
                                    <div
                                      style={{
                                        marginTop: 8,
                                        fontSize: 12,
                                        opacity: 0.75,
                                      }}
                                    >
                                      ✅ After Round 1 submission, this card’s
                                      roster is locked (no adding players to
                                      this card).
                                    </div>
                                  ) : (
                                    <div
                                      style={{
                                        marginTop: 8,
                                        fontSize: 12,
                                        opacity: 0.75,
                                      }}
                                    >
                                      After you submit Round 1 for this card,
                                      those players cannot be added to other
                                      cards.
                                    </div>
                                  )}
                                </>
                              )}
                            </div>

                            {/* (Optional) quick status */}
                            <div
                              style={{
                                marginTop: 10,
                                fontSize: 12,
                                opacity: 0.75,
                              }}
                            >
                              Card roster changes allowed:{" "}
                              <strong>
                                {canEditCardPlayers(c.id)
                                  ? "Yes (before Round 1 submit)"
                                  : "No"}
                              </strong>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* LEADERBOARDS */}
          <div style={{ textAlign: "left" }}>
            <div
              onClick={() => setLeaderboardsOpen((v) => !v)}
              style={{
                fontWeight: 900,
                color: COLORS.navy,
                marginBottom: 8,
                cursor: "pointer",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                borderRadius: 14,
                border: `1px solid ${COLORS.border}`,
                background: "#fff",
              }}
            >
              <span>
                Leaderboards (Only Submitted Rounds){" "}
                <span style={{ fontSize: 12, opacity: 0.75, fontWeight: 900 }}>
                  — {poolsEnabled ? "Split Pool" : "Combined Pool"}
                </span>
              </span>
              <span style={{ fontSize: 12, opacity: 0.75 }}>
                {leaderboardsOpen ? "Tap to hide" : "Tap to show"}
              </span>
            </div>

            {leaderboardsOpen && (
              <div style={{ display: "grid", gap: 10 }}>
                {leaderboardKeys.map((k) => {
                  const label = poolsEnabled
                    ? k === "A"
                      ? "A Pool"
                      : k === "B"
                      ? "B Pool"
                      : "C Pool"
                    : "Overall";
                  const rows = leaderboardGroups[k] || [];
                  const ranks = computeTiedRanks(rows);

                  return (
                    <div
                      key={k}
                      style={{
                        border: `1px solid ${COLORS.border}`,
                        borderRadius: 14,
                        background: "#fff",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          padding: "12px 12px",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 10,
                          background: COLORS.soft,
                        }}
                      >
                        <div style={{ fontWeight: 900, color: COLORS.navy }}>
                          {label}{" "}
                          <span style={{ fontSize: 12, opacity: 0.75 }}>
                            ({rows.length})
                          </span>
                        </div>
                      </div>

                      <div style={{ padding: 12 }}>
                        {rows.length === 0 ? (
                          <div style={{ fontSize: 12, opacity: 0.75 }}>
                            No players yet.
                          </div>
                        ) : (
                          <div style={{ display: "grid", gap: 8 }}>
                            {rows.map((r, idx) => {
                              const place = ranks[idx] || idx + 1;
                              return (
                                <div
                                  key={r.id}
                                  style={{
                                    padding: "10px 12px",
                                    borderRadius: 12,
                                    border: `1px solid ${COLORS.border}`,
                                    background: COLORS.soft,
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    gap: 10,
                                  }}
                                >
                                  <div
                                    style={{
                                      display: "flex",
                                      gap: 10,
                                      alignItems: "center",
                                      minWidth: 0,
                                    }}
                                  >
                                    <div
                                      style={{
                                        width: 34,
                                        height: 34,
                                        borderRadius: 12,
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        fontWeight: 900,
                                        color: "white",
                                        background: COLORS.navy,
                                        flexShrink: 0,
                                      }}
                                    >
                                      {place}
                                    </div>
                                    <div style={{ minWidth: 0 }}>
                                      <div
                                        style={{
                                          fontWeight: 900,
                                          color: COLORS.text,
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {r.name}
                                        {r.adj ? (
                                          <span
                                            style={{
                                              fontSize: 12,
                                              marginLeft: 8,
                                              opacity: 0.75,
                                            }}
                                          >
                                            (adj {r.adj > 0 ? "+" : ""}
                                            {r.adj})
                                          </span>
                                        ) : null}
                                      </div>
                                    </div>
                                  </div>

                                  <div
                                    style={{
                                      fontWeight: 900,
                                      color: COLORS.navy,
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {r.total} pts
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div
            style={{
              marginTop: 18,
              fontSize: 12,
              opacity: 0.65,
              textAlign: "center",
            }}
          >
            Sequential workflow: Admin locks format → check-in stays open while
            cards play → cards submit Round scores → admin locks check-in →
            finalize leaderboard.
          </div>

          <div
            style={{
              marginTop: 14,
              fontSize: 12,
              opacity: 0.55,
              textAlign: "center",
            }}
          >
            {APP_VERSION} • Developed by Eli Morgan
          </div>
        </div>
      </div>
    </div>
  );
}
