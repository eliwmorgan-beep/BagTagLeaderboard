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
const APP_VERSION = "v1.7.3";

// ✅ defaults now start at 0, and payouts can be enabled/disabled
const DEFAULT_PAYOUT_CONFIG = {
  enabled: false,
  buyInDollars: 0,
  leagueFeePct: 0,
  mode: "pool", // "pool" | "collective"
  updatedAt: null,
};

function uid() {
  return Math.random().toString(36).substring(2, 10);
}

function pointsForMade(made) {
  const m = Number(made);
  if (m >= 4) return 5;
  if (m === 3) return 3;
  if (m === 2) return 2;
  if (m === 1) return 1;
  return 0;
}

function clampMade(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(4, n));
}

/**
 * Compute card sizes using ONLY 2/3/4 (never 1).
 * Preference:
 *  - Never create 1s
 *  - Avoid 2s when possible
 *  - Keep sizes <= 4
 */
function computeCardSizesNoOnes(n) {
  if (n <= 0) return [];
  if (n === 1) return [1];
  if (n === 2) return [2];
  if (n === 3) return [3];
  if (n === 4) return [4];

  const sizes = [2, 3, 4];

  // DP where we pick the best combo for each sum:
  // Score tuple: [num2, num4, length] and we MINIMIZE it.
  // - fewer 2s first
  // - then fewer 4s
  // - then fewer total cards (shorter list)
  const best = Array.from({ length: n + 1 }, () => null);
  best[0] = { combo: [], score: [0, 0, 0] };

  function betterScore(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return true;
      if (a[i] > b[i]) return false;
    }
    return false;
  }

  for (let sum = 0; sum <= n; sum++) {
    if (!best[sum]) continue;
    for (const s of sizes) {
      const ns = sum + s;
      if (ns > n) continue;

      const prev = best[sum];
      const nextCombo = [...prev.combo, s];

      const num2 = prev.score[0] + (s === 2 ? 1 : 0);
      const num4 = prev.score[1] + (s === 4 ? 1 : 0);
      const len = prev.score[2] + 1;
      const nextScore = [num2, num4, len];

      if (!best[ns] || betterScore(nextScore, best[ns].score)) {
        best[ns] = { combo: nextCombo, score: nextScore };
      }
    }
  }

  const result = best[n]?.combo || [];

  if (result.some((x) => x === 1)) {
    return Array.from({ length: Math.floor(n / 3) }, () => 3).concat(
      n % 3 === 2 ? [2] : n % 3 === 1 ? [4] : []
    );
  }

  return result;
}

// ---------- Payout helpers ----------
function clampInt(n, min, max) {
  const x = Number(n);
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function payoutPlacesForPoolSize(count) {
  if (count > 7) return 3;
  if (count >= 5) return 2;
  if (count >= 2) return 1;
  if (count === 1) return 1;
  return 0;
}

function sharesByPoolMode(nPlaces) {
  if (nPlaces >= 3) return [0.5, 0.3, 0.2];
  if (nPlaces === 2) return [0.6, 0.4];
  if (nPlaces === 1) return [1.0];
  return [];
}

// Collective weights, ordered by priority: A1, A2, A3, B1, B2, C1
const COLLECTIVE_BASE_WEIGHTS = [30, 20, 15, 14, 11, 10]; // sums 100

function scaleWeightsToFractions(weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return [];
  return weights.map((w) => w / sum);
}

// Allocate INTEGER dollars across positions so total == potDollars
function allocatePositionAmountsDollars(potDollars, shares) {
  const n = shares.length;
  if (!n || potDollars <= 0) return Array(n).fill(0);

  const floats = shares.map((s) => s * potDollars);
  const floors = floats.map((x) => Math.floor(x));
  let used = floors.reduce((a, b) => a + b, 0);
  let remaining = potDollars - used;

  const frac = floats.map((x, i) => ({ i, f: x - Math.floor(x) }));
  frac.sort((a, b) => b.f - a.f);

  const amounts = [...floors];
  let idx = 0;
  while (remaining > 0 && idx < frac.length) {
    amounts[frac[idx].i] += 1;
    remaining -= 1;
    idx += 1;
    if (idx >= frac.length && remaining > 0) idx = 0;
  }

  const sum = amounts.reduce((a, b) => a + b, 0);
  if (sum > potDollars) {
    let extra = sum - potDollars;
    for (let i = amounts.length - 1; i >= 0 && extra > 0; i--) {
      const take = Math.min(extra, amounts[i]);
      amounts[i] -= take;
      extra -= take;
    }
  }

  return amounts;
}

// Tie-aware payout calculator for a single pool
function computeTieAwarePayoutsForPoolFromAmounts(rowsSorted, positionAmounts) {
  const nPositions = positionAmounts.length;
  const potDollars = positionAmounts.reduce((a, b) => a + b, 0);
  if (!rowsSorted.length || nPositions === 0 || potDollars <= 0) return {};

  const groups = [];
  for (const r of rowsSorted) {
    const last = groups[groups.length - 1];
    if (!last || last.total !== r.total)
      groups.push({ total: r.total, members: [r] });
    else last.members.push(r);
  }

  const payouts = {};
  let pos = 1;

  for (const g of groups) {
    const groupSize = g.members.length;
    const start = pos;
    const end = pos + groupSize - 1;

    if (start > nPositions) break;

    const coveredStart = Math.max(start, 1);
    const coveredEnd = Math.min(end, nPositions);

    let groupDollars = 0;
    for (let p = coveredStart; p <= coveredEnd; p++) {
      groupDollars += positionAmounts[p - 1] || 0;
    }

    if (groupDollars > 0) {
      const perMember = Math.floor(groupDollars / groupSize);
      let rem = groupDollars - perMember * groupSize;

      g.members.forEach((m) => {
        payouts[m.id] = (payouts[m.id] || 0) + perMember + (rem > 0 ? 1 : 0);
        if (rem > 0) rem -= 1;
      });
    }

    pos += groupSize;
    if (pos > nPositions) break;
  }

  return payouts;
}

// competition ranking ranks with ties: 1,2,2,5...
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

export default function PuttingPage() {
  const { leagueId } = useParams();

  // --- Palette / look (match Tags theme) ---
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

  // ✅ Firestore ref is now based on selected league (URL param)
  const leagueRef = useMemo(() => {
    if (!leagueId) return null;
    return doc(db, "leagues", leagueId);
  }, [leagueId]);

  const [putting, setPutting] = useState({
    settings: {
      // new:
      playMode: "simultaneous", // simultaneous | sequential
      poolMode: "split", // split | combined

      stations: 1,
      rounds: 1,

      // simultaneous:
      locked: false,
      currentRound: 0,
      finalized: false,
      cardMode: "", // "" | "manual" | "random"

      // sequential:
      formatLocked: false, // "Lock Format and Open Check-In"
      checkinLocked: false, // "Lock Check-In"
    },

    players: [],

    // simultaneous structures:
    cardsByRound: {},
    scores: {},
    submitted: {},

    // sequential structures:
    seqCards: [], // [{id,name,playerIds}]
    seqRoundScores: {}, // { round: { cardId: { playerId: number(0..50) } } }
    seqSubmitted: {}, // { round: { cardId: true } }

    adjustments: {},
    payoutConfig: { ...DEFAULT_PAYOUT_CONFIG },
    payoutsPosted: {},
  });

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  // UI state
  const [setupOpen, setSetupOpen] = useState(false);
  const [checkinOpen, setCheckinOpen] = useState(true);
  const [cardsOpen, setCardsOpen] = useState(true);
  const [leaderboardsOpen, setLeaderboardsOpen] = useState(false);
  const [payoutsOpen, setPayoutsOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);

  // Add player UI
  const [name, setName] = useState("");
  const [pool, setPool] = useState("A");

  // Simultaneous manual card creation UI (Round 1)
  const [selectedForCard, setSelectedForCard] = useState([]);
  const [cardName, setCardName] = useState("");

  // Sequential card creation UI
  const [seqSelected, setSeqSelected] = useState([]);
  const [seqCardName, setSeqCardName] = useState("");

  // Scorekeeper selection UI (simultaneous)
  const [activeCardId, setActiveCardId] = useState("");
  const [openStations, setOpenStations] = useState({});

  // ✅ Admin unlock window (device/tab specific)
  const [adminOkUntil, setAdminOkUntil] = useState(0);

  // -------- Helpers (computed) --------
  const settings = putting.settings || {};
  const playMode = String(settings.playMode || "simultaneous");
  const poolMode = String(settings.poolMode || "split");

  const stations = Math.max(1, Math.min(18, Number(settings.stations || 1)));
  const totalRounds = Math.max(1, Math.min(5, Number(settings.rounds || 1)));

  const finalized = !!settings.finalized;

  // simultaneous
  const currentRound = Number(settings.currentRound || 0);
  const cardMode = String(settings.cardMode || "");
  const roundStarted = !!settings.locked && currentRound >= 1;

  const players = Array.isArray(putting.players) ? putting.players : [];

  const cardsByRound =
    putting.cardsByRound && typeof putting.cardsByRound === "object"
      ? putting.cardsByRound
      : {};
  const scores =
    putting.scores && typeof putting.scores === "object" ? putting.scores : {};
  const submitted =
    putting.submitted && typeof putting.submitted === "object"
      ? putting.submitted
      : {};
  const adjustments =
    putting.adjustments && typeof putting.adjustments === "object"
      ? putting.adjustments
      : {};

  // sequential
  const formatLocked = !!settings.formatLocked;
  const checkinLocked = !!settings.checkinLocked;

  const seqCards = Array.isArray(putting.seqCards) ? putting.seqCards : [];
  const seqRoundScores =
    putting.seqRoundScores && typeof putting.seqRoundScores === "object"
      ? putting.seqRoundScores
      : {};
  const seqSubmitted =
    putting.seqSubmitted && typeof putting.seqSubmitted === "object"
      ? putting.seqSubmitted
      : {};

  const payoutConfig =
    putting.payoutConfig && typeof putting.payoutConfig === "object"
      ? { ...DEFAULT_PAYOUT_CONFIG, ...putting.payoutConfig }
      : { ...DEFAULT_PAYOUT_CONFIG };

  const payoutsEnabled = !!payoutConfig.enabled;

  const payoutsPosted =
    putting.payoutsPosted && typeof putting.payoutsPosted === "object"
      ? putting.payoutsPosted
      : {};

  const r1Cards = Array.isArray(cardsByRound["1"]) ? cardsByRound["1"] : [];
  const currentCards = Array.isArray(cardsByRound[String(currentRound)])
    ? cardsByRound[String(currentRound)]
    : [];

  const playerById = useMemo(() => {
    const map = {};
    players.forEach((p) => (map[p.id] = p));
    return map;
  }, [players]);

  // Return null if missing/unrecorded; otherwise 0..4
  function madeFor(roundNum, stationNum, playerId) {
    const r = scores?.[String(roundNum)] || {};
    const st = r?.[String(stationNum)] || {};
    const raw = st?.[playerId];

    if (raw === undefined || raw === null || raw === "") return null;

    const n = Number(raw);
    return Number.isNaN(n) ? null : n;
  }

  // 0 is valid and counts as recorded; only undefined/null/"" is missing
  function rawMadeExists(roundNum, stationNum, playerId) {
    const r = scores?.[String(roundNum)] || {};
    const st = r?.[String(stationNum)] || {};
    const raw = st?.[playerId];
    return !(raw === undefined || raw === null || raw === "");
  }

  function roundTotalForPlayer(roundNum, playerId) {
    let total = 0;
    for (let s = 1; s <= stations; s++) {
      const made = madeFor(roundNum, s, playerId);
      total += pointsForMade(made ?? 0);
    }
    return total;
  }

  function cumulativeBaseTotalForPlayer(playerId) {
    let total = 0;
    for (let r = 1; r <= totalRounds; r++) {
      total += roundTotalForPlayer(r, playerId);
    }
    return total;
  }

  function submittedCountForRound(roundNum) {
    const cards = Array.isArray(cardsByRound[String(roundNum)])
      ? cardsByRound[String(roundNum)]
      : [];
    const sub = submitted?.[String(roundNum)] || {};
    const count = cards.filter((c) => !!sub?.[c.id]).length;
    return { submitted: count, total: cards.length };
  }

  function allCardsSubmittedForRound(roundNum) {
    const { submitted: s, total: t } = submittedCountForRound(roundNum);
    return t > 0 && s === t;
  }

  function missingCardsForRound(roundNum) {
    const cards = Array.isArray(cardsByRound[String(roundNum)])
      ? cardsByRound[String(roundNum)]
      : [];
    const sub = submitted?.[String(roundNum)] || {};
    return cards.filter((c) => !sub?.[c.id]);
  }

  // sequential: next round needed for a card
  function seqNextRoundForCard(cardId) {
    for (let r = 1; r <= totalRounds; r++) {
      if (!seqSubmitted?.[String(r)]?.[cardId]) return r;
    }
    return null;
  }

  const cardsStillPlayingCount =
    playMode === "sequential"
      ? seqCards.filter((c) => seqNextRoundForCard(c.id) !== null).length
      : 0;

  // ✅ Admin password gate (unlocks for 10 minutes on THIS device/tab)
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
              playMode: "simultaneous",
              poolMode: "split",
              stations: 1,
              rounds: 1,
              locked: false,
              currentRound: 0,
              finalized: false,
              cardMode: "",
              formatLocked: false,
              checkinLocked: false,
            },
            players: [],
            cardsByRound: {},
            scores: {},
            submitted: {},
            seqCards: [],
            seqRoundScores: {},
            seqSubmitted: {},
            adjustments: {},
            payoutConfig: { ...DEFAULT_PAYOUT_CONFIG },
            payoutsPosted: {},
          },
        });
      }

      unsub = onSnapshot(
        leagueRef,
        (s) => {
          const data = s.data() || {};
          const pl = data.puttingLeague || {};
          const st = pl.settings || {};

          const safe = {
            ...pl,
            settings: {
              playMode: st.playMode || "simultaneous",
              poolMode: st.poolMode || "split",
              stations: Number(st.stations ?? 1),
              rounds: Number(st.rounds ?? 1),

              locked: !!st.locked,
              currentRound: Number(st.currentRound ?? 0),
              finalized: !!st.finalized,
              cardMode: String(st.cardMode || ""),

              formatLocked: !!st.formatLocked,
              checkinLocked: !!st.checkinLocked,
            },
            players: Array.isArray(pl.players) ? pl.players : [],
            cardsByRound:
              pl.cardsByRound && typeof pl.cardsByRound === "object"
                ? pl.cardsByRound
                : {},
            scores: pl.scores && typeof pl.scores === "object" ? pl.scores : {},
            submitted:
              pl.submitted && typeof pl.submitted === "object"
                ? pl.submitted
                : {},
            seqCards: Array.isArray(pl.seqCards) ? pl.seqCards : [],
            seqRoundScores:
              pl.seqRoundScores && typeof pl.seqRoundScores === "object"
                ? pl.seqRoundScores
                : {},
            seqSubmitted:
              pl.seqSubmitted && typeof pl.seqSubmitted === "object"
                ? pl.seqSubmitted
                : {},
            adjustments:
              pl.adjustments && typeof pl.adjustments === "object"
                ? pl.adjustments
                : {},
            payoutConfig:
              pl.payoutConfig && typeof pl.payoutConfig === "object"
                ? { ...DEFAULT_PAYOUT_CONFIG, ...pl.payoutConfig }
                : { ...DEFAULT_PAYOUT_CONFIG },
            payoutsPosted:
              pl.payoutsPosted && typeof pl.payoutsPosted === "object"
                ? pl.payoutsPosted
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

  // --------- Firestore update helpers ---------
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

  /* ===========================
     MODE / POOL DESCRIPTIONS
  =========================== */
  const modeDesc =
    playMode === "sequential"
      ? "Sequential: Cards play independently. Check-in stays open while cards play. Cards submit one total per player per round (0–50). Leaderboard shows each player’s score “through round X”."
      : "Simultaneous: Everyone is checked in first. All players are assigned to cards, and cards score per station in the same round at the same time. Between rounds, cards auto-create from standings.";

  const poolDesc =
    poolMode === "combined"
      ? "Combined Pool: Everyone is on one leaderboard. Pool selection is removed from check-in."
      : "Split Pool: Players choose A/B/C pool at check-in. Leaderboards (and payouts) split by pool.";

  /* ===========================
     POOL NORMALIZATION
     - If Combined Pool, we treat all players as pool 'A' internally.
  =========================== */
  const normalizedPlayers = useMemo(() => {
    if (poolMode !== "combined") return players;
    return players.map((p) => ({ ...p, pool: "A" }));
  }, [players, poolMode]);

  const normalizedPlayerById = useMemo(() => {
    const map = {};
    normalizedPlayers.forEach((p) => (map[p.id] = p));
    return map;
  }, [normalizedPlayers]);

  /* ===========================
     SIMULTANEOUS: CARD HELPERS
  =========================== */
  function validateRound1Cards(cards) {
    if (!Array.isArray(cards) || cards.length === 0) {
      return { ok: false, reason: "No cards created yet." };
    }

    const allIds = new Set(normalizedPlayers.map((p) => p.id));
    const seen = new Set();

    for (const c of cards) {
      const ids = Array.isArray(c.playerIds) ? c.playerIds : [];

      if (ids.length > 4)
        return { ok: false, reason: "A card has more than 4 players." };
      if (ids.length < 2) {
        return {
          ok: false,
          reason:
            "A card has only 1 player. Cards must have at least 2 players.",
        };
      }

      for (const pid of ids) {
        if (!allIds.has(pid))
          return { ok: false, reason: "A card contains an unknown player." };
        if (seen.has(pid))
          return {
            ok: false,
            reason: "A player appears on more than one card.",
          };
        seen.add(pid);
      }
    }

    if (seen.size !== allIds.size) {
      return {
        ok: false,
        reason: "Not all checked-in players are assigned to a card yet.",
      };
    }

    return { ok: true, reason: "" };
  }

  function buildRandomCardsRound1() {
    const arr = [...normalizedPlayers];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }

    const sizes = computeCardSizesNoOnes(arr.length);
    const cards = [];
    let idx = 0;

    sizes.forEach((sz) => {
      const chunk = arr.slice(idx, idx + sz);
      idx += sz;
      cards.push({
        id: uid(),
        name: `Card ${cards.length + 1}`,
        playerIds: chunk.map((p) => p.id),
      });
    });

    return cards;
  }

  function buildAutoCardsFromRound(roundNum) {
    const ranked = [...normalizedPlayers]
      .map((p) => ({ id: p.id, total: roundTotalForPlayer(roundNum, p.id) }))
      .sort((a, b) => b.total - a.total);

    const sizes = computeCardSizesNoOnes(ranked.length);
    const cards = [];
    let idx = 0;

    sizes.forEach((sz) => {
      const chunk = ranked.slice(idx, idx + sz);
      idx += sz;
      cards.push({
        id: uid(),
        name: `Card ${cards.length + 1}`,
        playerIds: chunk.map((x) => x.id),
      });
    });

    return cards;
  }

  /* ===========================
     ADMIN ACTIONS
  =========================== */

  // Add player (works for both modes; sequential respects checkin lock)
  async function addPlayer() {
    if (finalized) {
      alert("Scores are finalized. Reset to start a new league.");
      return;
    }

    // Simultaneous: no check-in after round started
    if (playMode === "simultaneous" && roundStarted) return;

    // Sequential: no check-in until format locked, and can be locked later
    if (playMode === "sequential") {
      if (!formatLocked) {
        alert("Check-in is closed until the admin clicks Lock Format and Open Check-In.");
        return;
      }
      if (checkinLocked) {
        alert("Check-in is locked.");
        return;
      }
    }

    const n = (name || "").trim();
    if (!n) return;

    const exists = normalizedPlayers.some(
      (p) => (p.name || "").trim().toLowerCase() === n.toLowerCase()
    );
    if (exists) {
      alert("That name is already checked in.");
      return;
    }

    const newPlayer = {
      id: uid(),
      name: n,
      pool: poolMode === "combined" ? "A" : pool || "A",
    };

    await updatePutting({ players: [...players, newPlayer] });

    setName("");
    setPool("A");
  }

  // Mode toggle
  async function setPlayMode(nextMode) {
    if (finalized) return;

    await requireAdmin(async () => {
      // If already "in progress" in one mode, warn
      const hasSimData =
        (putting.players?.length || 0) > 0 ||
        Object.keys(putting.cardsByRound || {}).length > 0 ||
        Object.keys(putting.scores || {}).length > 0;

      const hasSeqData =
        (putting.players?.length || 0) > 0 ||
        (putting.seqCards?.length || 0) > 0 ||
        Object.keys(putting.seqRoundScores || {}).length > 0;

      if ((nextMode === "simultaneous" && hasSeqData) || (nextMode === "sequential" && hasSimData)) {
        const ok = window.confirm(
          "Switching formats while data exists can be confusing.\n\nIf you are switching because you chose the wrong mode, consider resetting the Putting League first.\n\nSwitch anyway?"
        );
        if (!ok) return;
      }

      await updatePutting({
        settings: {
          ...settings,
          playMode: nextMode,
        },
      });
    });
  }

  // Pool mode toggle (disallow changing after players exist)
  async function setPoolMode(next) {
    if (finalized) return;
    await requireAdmin(async () => {
      if (players.length > 0) {
        alert("Pool mode can't be changed after players have checked in. Reset Putting League to change it.");
        return;
      }
      await updatePutting({
        settings: { ...settings, poolMode: next },
      });
    });
  }

  /* ===========================
     SIMULTANEOUS MODE ACTIONS
  =========================== */

  function toggleSelectForCard(playerId) {
    setSelectedForCard((prev) =>
      prev.includes(playerId)
        ? prev.filter((x) => x !== playerId)
        : [...prev, playerId]
    );
  }

  async function setCardModeManual() {
    if (finalized || roundStarted) return;
    await updatePutting({ settings: { ...settings, cardMode: "manual" } });
    setCardsOpen(true);
  }

  async function randomizeRound1Cards() {
    if (finalized || roundStarted) return;

    if (normalizedPlayers.length < 2) {
      alert("Check in at least 2 players first.");
      return;
    }

    const cards = buildRandomCardsRound1();
    await updatePutting({
      settings: { ...settings, cardMode: "random" },
      cardsByRound: { ...(putting.cardsByRound || {}), 1: cards },
      submitted: { ...(putting.submitted || {}), 1: {} },
    });

    setSelectedForCard([]);
    setCardName("");
    setCardsOpen(true);
  }

  async function createCardSimultaneous() {
    if (finalized) return;
    if (roundStarted) {
      alert("Round has started. Round 1 cards are locked.");
      return;
    }
    if (cardMode !== "manual") {
      alert("Choose 'Manually Create Cards' first.");
      return;
    }

    const count = selectedForCard.length;
    if (count < 2) return alert("Select at least 2 players for a card.");
    if (count > 4) return alert("Max 4 players per card.");

    const cards = Array.isArray(cardsByRound["1"]) ? cardsByRound["1"] : [];
    const used = new Set();
    cards.forEach((c) => (c.playerIds || []).forEach((id) => used.add(id)));

    const overlaps = selectedForCard.some((id) => used.has(id));
    if (overlaps)
      return alert(
        "One or more selected players are already assigned to a card."
      );

    const newCard = {
      id: uid(),
      name: (cardName || "").trim() || `Card ${cards.length + 1}`,
      playerIds: selectedForCard,
    };

    await updatePuttingDot("cardsByRound.1", [...cards, newCard]);

    setSelectedForCard([]);
    setCardName("");
    setName("");
    setPool("A");
  }

  async function beginRoundOneSimultaneous() {
    if (finalized) return;

    await requireAdmin(async () => {
      if (normalizedPlayers.length < 2)
        return alert("Check in at least 2 players first.");

      const check = validateRound1Cards(r1Cards);
      if (!check.ok) {
        alert(
          `Round 1 can't begin yet.\n\n${check.reason}\n\nTip: Choose "Manually Create Cards" or "Randomize Cards" and make sure everyone is assigned.`
        );
        return;
      }

      await updatePutting({
        settings: {
          ...settings,
          stations,
          rounds: totalRounds,
          locked: true,
          currentRound: 1,
          finalized: false,
        },
        submitted: {
          ...(putting.submitted || {}),
          1: putting.submitted?.["1"] || {},
        },
      });

      setSetupOpen(false);
      setCardsOpen(true);
      setPayoutsOpen(false);
      window.scrollTo(0, 0);
    });
  }

  async function beginNextRoundSimultaneous() {
    if (finalized) return;

    await requireAdmin(async () => {
      if (!settings.locked || currentRound < 1)
        return alert("Round 1 has not begun yet.");
      if (currentRound >= totalRounds)
        return alert("You are already on the final round.");
      if (!allCardsSubmittedForRound(currentRound)) {
        const missing = missingCardsForRound(currentRound);
        const names = missing.map((c) => c.name).join(", ");
        alert(
          `Not all cards have submitted scores for Round ${currentRound} yet.\n\nWaiting on: ${
            names || "Unknown"
          }`
        );
        return;
      }

      const nextRound = currentRound + 1;
      const autoCards = buildAutoCardsFromRound(currentRound);

      await updatePutting({
        settings: { ...settings, currentRound: nextRound },
        cardsByRound: {
          ...(putting.cardsByRound || {}),
          [String(nextRound)]: autoCards,
        },
        submitted: { ...(putting.submitted || {}), [String(nextRound)]: {} },
      });

      setActiveCardId("");
      setOpenStations({});
      window.scrollTo(0, 0);
    });
  }

  async function finalizeScoresSimultaneous() {
    if (!settings.locked || currentRound < 1)
      return alert("League hasn't started yet.");
    if (currentRound !== totalRounds)
      return alert("Finalize is only available on the final round.");
    if (!allCardsSubmittedForRound(currentRound)) {
      const missing = missingCardsForRound(currentRound);
      const names = missing.map((c) => c.name).join(", ");
      alert(
        `Not all cards have submitted scores for the final round yet.\n\nWaiting on: ${
          names || "Unknown"
        }`
      );
      return;
    }

    await updatePutting({ settings: { ...settings, finalized: true } });

    setAdjustOpen(false);
    setPayoutsOpen(false);
    alert("Scores finalized. Leaderboards are now locked.");
  }

  /* ===========================
     SEQUENTIAL MODE ACTIONS
  =========================== */

  async function lockFormatAndOpenCheckin() {
    if (finalized) return;
    await requireAdmin(async () => {
      await updatePutting({
        settings: {
          ...settings,
          stations,
          rounds: totalRounds,
          locked: false,
          currentRound: 0,
          cardMode: "",
          formatLocked: true,
          checkinLocked: false,
          finalized: false,
        },
      });
      setSetupOpen(false);
      setCheckinOpen(true);
      setCardsOpen(true);
      window.scrollTo(0, 0);
    });
  }

  async function lockCheckinSequential() {
    if (finalized) return;
    await requireAdmin(async () => {
      if (!formatLocked) return alert("Format is not locked/open yet.");
      await updatePutting({
        settings: {
          ...settings,
          checkinLocked: true,
        },
      });
    });
  }

  function seqAssignedPlayerIds() {
    const used = new Set();
    seqCards.forEach((c) => (c.playerIds || []).forEach((id) => used.add(id)));
    return used;
  }

  const seqUnassignedPlayers = useMemo(() => {
    const used = seqAssignedPlayerIds();
    return normalizedPlayers.filter((p) => !used.has(p.id));
  }, [normalizedPlayers, seqCards]);

  function toggleSeqSelect(playerId) {
    setSeqSelected((prev) =>
      prev.includes(playerId)
        ? prev.filter((x) => x !== playerId)
        : [...prev, playerId]
    );
  }

  async function createCardSequential() {
    if (finalized) return;

    if (!formatLocked) {
      alert("Admin must click Lock Format and Open Check-In first.");
      return;
    }

    const count = seqSelected.length;
    if (count < 2) return alert("Select at least 2 players for a card.");
    if (count > 4) return alert("Max 4 players per card.");

    const used = seqAssignedPlayerIds();
    const overlaps = seqSelected.some((id) => used.has(id));
    if (overlaps) {
      alert("One or more selected players are already assigned to a card.");
      return;
    }

    const newCard = {
      id: uid(),
      name: (seqCardName || "").trim() || `Card ${seqCards.length + 1}`,
      playerIds: [...seqSelected],
    };

    await updatePutting({
      seqCards: [...seqCards, newCard],
    });

    setSeqSelected([]);
    setSeqCardName("");
  }

  function seqCardRoundTotalsForPlayer(playerId) {
    // returns { total, throughRound }
    let total = 0;
    let through = 0;
    for (let r = 1; r <= totalRounds; r++) {
      // only count if that round has been submitted by THAT card; but we don't know card here
      // In sequential, we count a player's round if there exists a submitted card round that contains them.
      const roundSubmitted = seqSubmitted?.[String(r)] || {};
      const roundScores = seqRoundScores?.[String(r)] || {};
      let counted = false;

      Object.keys(roundSubmitted).forEach((cardId) => {
        if (!roundSubmitted[cardId]) return;
        const card = seqCards.find((c) => c.id === cardId);
        if (!card) return;
        if (!(card.playerIds || []).includes(playerId)) return;

        const raw = roundScores?.[cardId]?.[playerId];
        const val = Number(raw);
        if (!Number.isNaN(val)) {
          total += val;
          counted = true;
        }
      });

      if (counted) through = r;
    }
    return { total, throughRound: through };
  }

  async function setSeqPlayerRoundScore(roundNum, cardId, playerId, val) {
    if (finalized) return;

    const n = clampInt(val, 0, 50);

    const path = `puttingLeague.seqRoundScores.${String(roundNum)}.${String(
      cardId
    )}.${String(playerId)}`;

    await updateDoc(leagueRef, { [path]: n });
  }

  async function submitSeqCardRound(cardId, roundNum) {
    if (finalized) return;

    const card = seqCards.find((c) => c.id === cardId);
    if (!card) return;

    // Require all players filled
    const roundScores = seqRoundScores?.[String(roundNum)]?.[cardId] || {};
    for (const pid of card.playerIds || []) {
      const raw = roundScores?.[pid];
      if (raw === undefined || raw === null || raw === "") {
        alert("Fill all player scores for this round (0–50).");
        return;
      }
      const n = Number(raw);
      if (Number.isNaN(n)) {
        alert("Scores must be numbers.");
        return;
      }
    }

    // ✅ No admin password required to submit a card round
    await updatePuttingDot(
      `seqSubmitted.${String(roundNum)}.${String(cardId)}`,
      true
    );
    alert(`Submitted Round ${roundNum} ✅`);
  }

  async function finalizeLeaderboardSequential() {
    if (finalized) return;

    await requireAdmin(async () => {
      const ok = window.confirm(
        "Finalize Leaderboard?\n\nThis locks all scores and prevents any more submissions."
      );
      if (!ok) return;

      await updatePutting({
        settings: { ...settings, finalized: true },
      });
      alert("Finalized ✅");
    });
  }

  /* ===========================
     RESET
  =========================== */
  async function resetPuttingLeague() {
    await requireAdmin(async () => {
      const ok = window.confirm(
        "Reset PUTTING league only?\n\nThis clears putting players, cards, scores, settings, leaderboard adjustments, and payout settings."
      );
      if (!ok) return;

      await updateDoc(leagueRef, {
        puttingLeague: {
          settings: {
            playMode: "simultaneous",
            poolMode: "split",
            stations: 1,
            rounds: 1,
            locked: false,
            currentRound: 0,
            finalized: false,
            cardMode: "",
            formatLocked: false,
            checkinLocked: false,
          },
          players: [],
          cardsByRound: {},
          scores: {},
          submitted: {},
          seqCards: [],
          seqRoundScores: {},
          seqSubmitted: {},
          adjustments: {},
          payoutConfig: { ...DEFAULT_PAYOUT_CONFIG },
          payoutsPosted: {},
        },
      });

      setActiveCardId("");
      setOpenStations({});
      setSelectedForCard([]);
      setCardName("");
      setSeqSelected([]);
      setSeqCardName("");
      setName("");
      setPool("A");
      setSetupOpen(false);
      setCheckinOpen(true);
      setCardsOpen(true);
      setLeaderboardsOpen(false);
      setAdjustOpen(false);
      setPayoutsOpen(false);
    });
  }

  /* ===========================
     ADJUSTMENTS (shared)
  =========================== */
  async function openAdjustmentsEditor() {
    if (finalized)
      return alert("Leaderboards are finalized. Adjustments are locked.");
    await requireAdmin(async () => setAdjustOpen((v) => !v));
  }

  async function setFinalLeaderboardTotal(playerId, desiredFinalTotal) {
    if (finalized) return;

    await requireAdmin(async () => {
      const base =
        playMode === "simultaneous"
          ? cumulativeBaseTotalForPlayer(playerId)
          : seqCardRoundTotalsForPlayer(playerId).total;

      const desired = Number(desiredFinalTotal);
      if (Number.isNaN(desired)) return;

      const adj = desired - base;
      await updatePuttingDot(`adjustments.${playerId}`, adj);
    });
  }

  async function clearAdjustment(playerId) {
    if (finalized) return;

    await requireAdmin(async () => {
      const path = `puttingLeague.adjustments.${playerId}`;
      await updateDoc(leagueRef, { [path]: deleteField() });
    });
  }

  /* ===========================
     SCOREKEEPER (SIMULTANEOUS)
  =========================== */
  function toggleStation(stationNum) {
    setOpenStations((prev) => ({ ...prev, [stationNum]: !prev[stationNum] }));
  }

  async function setMade(roundNum, stationNum, playerId, made) {
    if (finalized) return;
    if (roundNum !== currentRound)
      return alert("This round is locked because the league has moved on.");

    const card = currentCards.find((c) =>
      (c.playerIds || []).includes(playerId)
    );
    if (card) {
      const alreadySubmitted = !!submitted?.[String(currentRound)]?.[card.id];
      if (alreadySubmitted) return;
    }

    const path = `puttingLeague.scores.${String(roundNum)}.${String(
      stationNum
    )}.${playerId}`;

    if (made === "" || made === null || made === undefined) {
      await updateDoc(leagueRef, { [path]: deleteField() });
      return;
    }

    const val = clampMade(made);
    await updateDoc(leagueRef, { [path]: val });
  }

  function isCardFullyFilled(roundNum, card) {
    const ids = card?.playerIds || [];
    if (!ids.length) return false;

    for (let s = 1; s <= stations; s++) {
      for (const pid of ids) {
        if (!rawMadeExists(roundNum, s, pid)) return false;
      }
    }
    return true;
  }

  async function submitCardScores(cardId) {
    if (finalized) return;

    const card = currentCards.find((c) => c.id === cardId);
    if (!card) return;

    if (!isCardFullyFilled(currentRound, card)) {
      alert(
        "This card is missing some scores. Fill all stations for all players."
      );
      return;
    }

    await updatePuttingDot(`submitted.${String(currentRound)}.${cardId}`, true);
    alert("Card submitted (locked)!");
  }

  /* ===========================
     LEADERBOARDS
     - Simultaneous: cumulative by stations/rounds
     - Sequential: cumulative of submitted rounds only, with "through round X"
     - Pool mode: split or combined
  =========================== */
  const leaderboardData = useMemo(() => {
    const pools = { A: [], B: [], C: [] };

    normalizedPlayers.forEach((p) => {
      const base =
        playMode === "simultaneous"
          ? cumulativeBaseTotalForPlayer(p.id)
          : seqCardRoundTotalsForPlayer(p.id).total;

      const through =
        playMode === "sequential"
          ? seqCardRoundTotalsForPlayer(p.id).throughRound
          : totalRounds;

      const adj = Number(adjustments?.[p.id] ?? 0) || 0;
      const total = base + adj;

      const payoutDollars = Number(payoutsPosted?.[p.id] ?? 0) || 0;

      const row = {
        id: p.id,
        name: p.name,
        pool: p.pool,
        total,
        adj,
        payoutDollars,
        throughRound: through,
      };

      if (poolMode === "combined") {
        pools.A.push(row);
      } else {
        if (p.pool === "B") pools.B