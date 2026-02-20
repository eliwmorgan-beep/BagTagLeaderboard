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
 * - Never create 1s
 * - Avoid 2s when possible
 * - Keep sizes <= 4
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

  /* =========================== MODE / POOL DESCRIPTIONS =========================== */
  const modeDesc =
    playMode === "sequential"
      ? "Sequential: Cards play independently. Check-in stays open while cards play. Cards submit one total per player per round (0–50). Leaderboard shows each player’s score “through round X”."
      : "Simultaneous: Everyone is checked in first. All players are assigned to cards, and cards score per station in the same round at the same time. Between rounds, cards auto-create from standings.";

  const poolDesc =
    poolMode === "combined"
      ? "Combined Pool: Everyone is on one leaderboard. Pool selection is removed from check-in."
      : "Split Pool: Players choose A/B/C pool at check-in. Leaderboards (and payouts) split by pool.";

  /* =========================== POOL NORMALIZATION =========================== */
  const normalizedPlayers = useMemo(() => {
    if (poolMode !== "combined") return players;
    return players.map((p) => ({ ...p, pool: "A" }));
  }, [players, poolMode]);

  const normalizedPlayerById = useMemo(() => {
    const map = {};
    normalizedPlayers.forEach((p) => (map[p.id] = p));
    return map;
  }, [normalizedPlayers]);

  /* =========================== SIMULTANEOUS: CARD HELPERS =========================== */
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

  /* =========================== SEQUENTIAL: RANDOMIZE CARDS HELPERS =========================== */
  function buildRandomSeqCardsAllPlayers() {
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

  async function randomizeSequentialCards() {
    if (finalized) return;
    if (playMode !== "sequential") return;
    if (!formatLocked)
      return alert("Admin must click Lock Format and Open Check-In first.");
    // ✅ CHANGE #1: Do not allow / do not show this until check-in is locked
    if (!checkinLocked) return;

    await requireAdmin(async () => {
      if (normalizedPlayers.length < 2) {
        alert("Check in at least 2 players first.");
        return;
      }

      const ok = window.confirm(
        "Randomize cards for all checked-in players?\n\nThis will replace any existing cards."
      );
      if (!ok) return;

      const cards = buildRandomSeqCardsAllPlayers();

      // Replace cards. Keep any existing scores/submissions (rare) would mismatch,
      // so we clear sequential scoring/submission state when re-randomizing.
      await updatePutting({
        seqCards: cards,
        seqRoundScores: {},
        seqSubmitted: {},
      });

      setSeqSelected([]);
      setSeqCardName("");
      setCardsOpen(true);
    });
  }

  /* =========================== ADMIN ACTIONS =========================== */
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
        alert(
          "Check-in is closed until the admin clicks Lock Format and Open Check-In."
        );
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
      const hasSimData =
        (putting.players?.length || 0) > 0 ||
        Object.keys(putting.cardsByRound || {}).length > 0 ||
        Object.keys(putting.scores || {}).length > 0;

      const hasSeqData =
        (putting.players?.length || 0) > 0 ||
        (putting.seqCards?.length || 0) > 0 ||
        Object.keys(putting.seqRoundScores || {}).length > 0;

      if (
        (nextMode === "simultaneous" && hasSeqData) ||
        (nextMode === "sequential" && hasSimData)
      ) {
        const ok = window.confirm(
          "Switching formats while data exists can be confusing.\n\nIf you are switching because you chose the wrong mode, consider resetting the Putting League first.\n\nSwitch anyway?"
        );
        if (!ok) return;
      }

      await updatePutting({
        settings: { ...settings, playMode: nextMode },
      });
    });
  }

  // Pool mode toggle (disallow changing after players exist)
  async function setPoolMode(next) {
    if (finalized) return;
    await requireAdmin(async () => {
      if (players.length > 0) {
        alert(
          "Pool mode can't be changed after players have checked in. Reset Putting League to change it."
        );
        return;
      }
      await updatePutting({ settings: { ...settings, poolMode: next } });
    });
  }

  /* =========================== SIMULTANEOUS MODE ACTIONS =========================== */
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
      // ✅ CHANGE #2: Keep function same; just wording updated elsewhere
      alert('Choose "Manually Create Card(s)" first.');
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
          `Round 1 can't begin yet.\n\n${check.reason}\n\nTip: Choose "Manually Create Card(s)" or "Randomize Cards" and make sure everyone is assigned.`
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
        submitted: {
          ...(putting.submitted || {}),
          [String(nextRound)]: {},
        },
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

  /* =========================== SEQUENTIAL MODE ACTIONS =========================== */
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
      await updatePutting({ settings: { ...settings, checkinLocked: true } });
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

    await updatePutting({ seqCards: [...seqCards, newCard] });
    setSeqSelected([]);
    setSeqCardName("");
  }

  function seqCardRoundTotalsForPlayer(playerId) {
    // returns { total, throughRound }
    let total = 0;
    let through = 0;

    for (let r = 1; r <= totalRounds; r++) {
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
      await updatePutting({ settings: { ...settings, finalized: true } });
      alert("Finalized ✅");
    });
  }

  /* =========================== RESET =========================== */
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

  /* =========================== ADJUSTMENTS (shared) =========================== */
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

  /* =========================== SCOREKEEPER (SIMULTANEOUS) =========================== */
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

  /* =========================== LEADERBOARDS =========================== */
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

      if (poolMode === "combined") pools.A.push(row);
      else {
        if (p.pool === "B") pools.B.push(row);
        else if (p.pool === "C") pools.C.push(row);
        else pools.A.push(row);
      }
    });

    Object.keys(pools).forEach((k) =>
      pools[k].sort((a, b) => b.total - a.total)
    );
    return pools;
  }, [
    normalizedPlayers,
    playMode,
    poolMode,
    scores,
    stations,
    totalRounds,
    adjustments,
    payoutsPosted,
    seqCards,
    seqRoundScores,
    seqSubmitted,
  ]);

  /* =========================== PAYOUTS =========================== */
  function computeAllPayoutsDollars() {
    if (!payoutConfig) return { ok: false, reason: "No payout configuration." };
    if (!payoutConfig.enabled)
      return { ok: false, reason: "Payouts are disabled." };

    const buyIn = clampInt(payoutConfig.buyInDollars, 0, 50);
    const feePct = clampInt(payoutConfig.leagueFeePct, 0, 50);
    const mode = payoutConfig.mode;

    if (!normalizedPlayers.length)
      return { ok: false, reason: "No players checked in." };

    const totalPotDollars = buyIn * normalizedPlayers.length;
    const feeDollars = Math.round((totalPotDollars * feePct) / 100);
    const potAfterFeeDollars = Math.max(0, totalPotDollars - feeDollars);
    if (potAfterFeeDollars <= 0)
      return { ok: false, reason: "Pot after fee is $0." };

    const pools = {
      A: (leaderboardData.A || []).map((r) => ({
        id: r.id,
        total: r.total,
        name: r.name,
      })),
      B: (leaderboardData.B || []).map((r) => ({
        id: r.id,
        total: r.total,
        name: r.name,
      })),
      C: (leaderboardData.C || []).map((r) => ({
        id: r.id,
        total: r.total,
        name: r.name,
      })),
    };

    const countA = pools.A.length;
    const countB = pools.B.length;
    const countC = pools.C.length;

    if (mode === "pool") {
      const payouts = {};
      const poolPotDollars = (poolCount) => {
        const poolTotal = buyIn * poolCount;
        const poolFee = Math.round((poolTotal * feePct) / 100);
        return Math.max(0, poolTotal - poolFee);
      };

      const doPool = (key) => {
        const rows = pools[key];
        const pot = poolPotDollars(rows.length);
        const places = payoutPlacesForPoolSize(rows.length);
        const shares = sharesByPoolMode(places);
        const positionAmounts = allocatePositionAmountsDollars(pot, shares);
        const poolPayouts = computeTieAwarePayoutsForPoolFromAmounts(
          rows,
          positionAmounts
        );
        Object.entries(poolPayouts).forEach(([pid, dollars]) => {
          payouts[pid] = (payouts[pid] || 0) + (Number(dollars) || 0);
        });
      };

      if (countA) doPool("A");
      if (countB) doPool("B");
      if (countC) doPool("C");

      return {
        ok: true,
        payouts,
        meta: {
          buyIn,
          feePct,
          mode,
          totalPotDollars,
          feeDollars,
          potAfterFeeDollars,
        },
      };
    }

    const placesA = payoutPlacesForPoolSize(countA);
    const placesB = payoutPlacesForPoolSize(countB);
    const placesC = payoutPlacesForPoolSize(countC);

    const slots = [];
    for (let i = 1; i <= Math.min(3, placesA); i++)
      slots.push({ pool: "A", pos: i });
    for (let i = 1; i <= Math.min(2, placesB); i++)
      slots.push({ pool: "B", pos: i });
    for (let i = 1; i <= Math.min(1, placesC); i++)
      slots.push({ pool: "C", pos: i });

    if (!slots.length)
      return { ok: false, reason: "No payout slots available." };

    const base = COLLECTIVE_BASE_WEIGHTS.slice(0, slots.length);
    const slotShares = scaleWeightsToFractions(base);
    const slotAmounts = allocatePositionAmountsDollars(
      potAfterFeeDollars,
      slotShares
    );

    const perPoolPositionAmounts = { A: [], B: [], C: [] };
    slots.forEach((slot, idx) => {
      const amt = slotAmounts[idx] || 0;
      const posIndex = slot.pos - 1;
      perPoolPositionAmounts[slot.pool][posIndex] =
        (perPoolPositionAmounts[slot.pool][posIndex] || 0) + amt;
    });

    const payouts = {};
    ["A", "B", "C"].forEach((k) => {
      const amounts = perPoolPositionAmounts[k].filter(
        (x) => typeof x === "number"
      );
      if (!amounts.length) return;
      const poolPayouts = computeTieAwarePayoutsForPoolFromAmounts(
        pools[k],
        amounts
      );
      Object.entries(poolPayouts).forEach(([pid, dollars]) => {
        payouts[pid] = (payouts[pid] || 0) + (Number(dollars) || 0);
      });
    });

    return {
      ok: true,
      payouts,
      meta: {
        buyIn,
        feePct,
        mode,
        totalPotDollars,
        feeDollars,
        potAfterFeeDollars,
        collectiveWeightsUsed: base,
      },
    };
  }

  async function postPayoutsToLeaderboard() {
    if (!finalized) return;
    await requireAdmin(async () => {
      if (!payoutConfig.enabled) return alert("Payouts are disabled.");
      const result = computeAllPayoutsDollars();
      if (!result.ok)
        return alert(result.reason || "Unable to compute payouts.");
      const ok = window.confirm(
        "Post payouts to the leaderboard?\n\nThis will write FULL DOLLAR amounts next to the winning players."
      );
      if (!ok) return;
      await updatePutting({ payoutsPosted: result.payouts });
      alert("Payouts posted ✅");
    });
  }

  async function togglePayoutsEnabled() {
    await requireAdmin(async () => {
      const next = !payoutConfig.enabled;
      if (!next) {
        await updatePutting({
          payoutConfig: {
            ...payoutConfig,
            enabled: false,
            updatedAt: Date.now(),
          },
          payoutsPosted: {},
        });
        setPayoutsOpen(false);
        alert("Payouts disabled (posted payouts cleared).");
        return;
      }
      await updatePutting({
        payoutConfig: { ...payoutConfig, enabled: true, updatedAt: Date.now() },
        payoutsPosted: {},
      });
      alert("Payouts enabled ✅");
    });
  }

  /* =========================== UI GATING =========================== */
  const canBeginNextRound =
    playMode === "simultaneous" &&
    roundStarted &&
    !finalized &&
    currentRound < totalRounds &&
    allCardsSubmittedForRound(currentRound);

  const canFinalize =
    playMode === "simultaneous" &&
    roundStarted &&
    !finalized &&
    currentRound === totalRounds &&
    allCardsSubmittedForRound(currentRound);

  const submitStats =
    playMode === "simultaneous" && roundStarted
      ? submittedCountForRound(currentRound)
      : { submitted: 0, total: 0 };

  const missingCardsThisRound =
    playMode === "simultaneous" && roundStarted
      ? missingCardsForRound(currentRound)
      : [];

  const showCardModeButtons =
    playMode === "simultaneous" &&
    !roundStarted &&
    !finalized &&
    normalizedPlayers.length >= 2;

  const hasPostedPayouts =
    payoutsEnabled && Object.keys(payoutsPosted || {}).length > 0;

  /* =========================== GUARDS =========================== */
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

  /* =========================== RENDER =========================== */
  return (
    <div
      style={{
        minHeight: "100vh",
        background: `linear-gradient(180deg, ${COLORS.blueLight} 0%, #ffffff 60%)`,
        display: "flex",
        justifyContent: "center",
        // ✅ responsive outer padding (keeps desktop same; gives phones room)
        padding: "clamp(12px, 4vw, 24px)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 760 }}>
        <div
          style={{
            textAlign: "center",
            background: COLORS.panel,
            borderRadius: 18,
            // ✅ responsive panel padding (keeps desktop same; gives phones room)
            padding: "clamp(14px, 4vw, 26px)",
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
                opacity: 1,
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
            Putting League —{" "}
            <span style={{ color: COLORS.navy }}>
              {playMode === "sequential"
                ? "Sequential Mode"
                : "Simultaneous Mode"}
            </span>
            {finalized ? (
              <div style={{ marginTop: 6, color: COLORS.red, fontWeight: 900 }}>
                FINALIZED (locked)
              </div>
            ) : null}
          </div>

          {/* Sequential top indicator */}
          {playMode === "sequential" && (
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 14 }}>
              Cards still playing:{" "}
              <strong>
                {cardsStillPlayingCount} / {seqCards.length}
              </strong>
            </div>
          )}

          {/* Admin status (simultaneous only) */}
          {playMode === "simultaneous" && roundStarted && (
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 14 }}>
              <div>
                Admin Status: Cards submitted this round —{" "}
                <strong>
                  {submitStats.submitted} / {submitStats.total}
                </strong>
              </div>
              {missingCardsThisRound.length > 0 ? (
                <div style={{ marginTop: 6 }}>
                  Waiting on:{" "}
                  <strong style={{ color: COLORS.red }}>
                    {missingCardsThisRound.map((c) => c.name).join(", ")}
                  </strong>
                </div>
              ) : (
                <div
                  style={{ marginTop: 6, color: COLORS.green, fontWeight: 900 }}
                >
                  All cards submitted ✅
                </div>
              )}
            </div>
          )}

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
              <div style={{ marginTop: 10 }}>
                <div style={{ display: "grid", gap: 10 }}>
                  {/* ✅ Format selector */}
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 900,
                        color: COLORS.navy,
                        marginBottom: 6,
                      }}
                    >
                      Format Mode
                    </div>
                    <select
                      value={playMode}
                      onChange={(e) => setPlayMode(e.target.value)}
                      style={{
                        ...inputStyle,
                        width: "100%",
                        background: "#fff",
                      }}
                      disabled={finalized}
                      title="Requires admin password"
                    >
                      <option value="simultaneous">
                        Simultaneous Stations
                      </option>
                      <option value="sequential">Sequential Stations</option>
                    </select>
                  </div>

                  {/* ✅ Pool selector */}
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
                    <select
                      value={poolMode}
                      onChange={(e) => setPoolMode(e.target.value)}
                      style={{
                        ...inputStyle,
                        width: "100%",
                        background: "#fff",
                      }}
                      disabled={finalized}
                      title="Requires admin password"
                    >
                      <option value="split">Split Pool (A/B/C)</option>
                      <option value="combined">
                        Combined Pool (One leaderboard)
                      </option>
                    </select>
                  </div>

                  {/* ✅ Dynamic explanations */}
                  <div style={{ fontSize: 12, opacity: 0.8, lineHeight: 1.35 }}>
                    <div
                      style={{
                        fontWeight: 900,
                        color: COLORS.navy,
                        marginBottom: 4,
                      }}
                    >
                      What these mean:
                    </div>
                    <div style={{ marginBottom: 8 }}>{modeDesc}</div>
                    <div>{poolDesc}</div>
                  </div>

                  <div style={{ display: "grid", gap: 10 }}>
                    <div>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 900,
                          color: COLORS.navy,
                          marginBottom: 6,
                        }}
                      >
                        Stations (1–18)
                      </div>
                      <select
                        value={stations}
                        disabled={
                          finalized ||
                          (playMode === "simultaneous"
                            ? roundStarted
                            : formatLocked)
                        }
                        onChange={(e) =>
                          updatePutting({
                            settings: {
                              ...settings,
                              stations: Number(e.target.value),
                            },
                          })
                        }
                        style={{
                          ...inputStyle,
                          width: "100%",
                          background: "#fff",
                        }}
                      >
                        {Array.from({ length: 18 }, (_, i) => i + 1).map(
                          (n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          )
                        )}
                      </select>
                    </div>

                    <div>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 900,
                          color: COLORS.navy,
                          marginBottom: 6,
                        }}
                      >
                        Rounds
                      </div>
                      <select
                        value={totalRounds}
                        disabled={
                          finalized ||
                          (playMode === "simultaneous"
                            ? roundStarted
                            : formatLocked)
                        }
                        onChange={(e) =>
                          updatePutting({
                            settings: {
                              ...settings,
                              rounds: Number(e.target.value),
                            },
                          })
                        }
                        style={{
                          ...inputStyle,
                          width: "100%",
                          background: "#fff",
                        }}
                      >
                        {Array.from({ length: 5 }, (_, i) => i + 1).map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Simultaneous control */}
                    {playMode === "simultaneous" && !roundStarted && (
                      <button
                        onClick={beginRoundOneSimultaneous}
                        style={{
                          ...buttonStyle,
                          width: "100%",
                          background: COLORS.green,
                          color: "white",
                          border: `1px solid ${COLORS.green}`,
                        }}
                        disabled={finalized}
                        title="Requires admin password."
                      >
                        Begin Round 1 (Lock Format)
                      </button>
                    )}

                    {/* Sequential control */}
                    {playMode === "sequential" && !formatLocked && (
                      <button
                        onClick={lockFormatAndOpenCheckin}
                        style={{
                          ...buttonStyle,
                          width: "100%",
                          background: COLORS.green,
                          color: "white",
                          border: `1px solid ${COLORS.green}`,
                        }}
                        disabled={finalized}
                        title="Requires admin password."
                      >
                        Lock Format and Open Check-In
                      </button>
                    )}

                    {playMode === "sequential" &&
                      formatLocked &&
                      !checkinLocked && (
                        <button
                          onClick={lockCheckinSequential}
                          style={{
                            ...buttonStyle,
                            width: "100%",
                            background: COLORS.navy,
                            color: "white",
                            border: `1px solid ${COLORS.navy}`,
                          }}
                          disabled={finalized}
                          title="Requires admin password."
                        >
                          Lock Check-In
                        </button>
                      )}

                    {playMode === "sequential" && formatLocked && (
                      <button
                        onClick={finalizeLeaderboardSequential}
                        style={{
                          ...buttonStyle,
                          width: "100%",
                          background: COLORS.red,
                          color: "white",
                          border: `1px solid ${COLORS.red}`,
                        }}
                        disabled={finalized}
                        title="Requires admin password."
                      >
                        Finalize Leaderboard (Lock)
                      </button>
                    )}

                    {/* Simultaneous next round / finalize */}
                    {playMode === "simultaneous" && canBeginNextRound && (
                      <button
                        onClick={beginNextRoundSimultaneous}
                        style={{
                          ...buttonStyle,
                          width: "100%",
                          background: COLORS.navy,
                          color: "white",
                          border: `1px solid ${COLORS.navy}`,
                        }}
                        title="Requires admin password."
                      >
                        Begin Next Round (Auto Cards)
                      </button>
                    )}

                    {playMode === "simultaneous" && canFinalize && (
                      <button
                        onClick={finalizeScoresSimultaneous}
                        style={{
                          ...buttonStyle,
                          width: "100%",
                          background: COLORS.red,
                          color: "white",
                          border: `1px solid ${COLORS.red}`,
                        }}
                        title="No password required."
                      >
                        Finalize Scores (Lock)
                      </button>
                    )}

                    {/* Adjust tool */}
                    <button
                      onClick={openAdjustmentsEditor}
                      style={{
                        ...smallButtonStyle,
                        width: "100%",
                        background: "#fff",
                        border: `1px solid ${COLORS.navy}`,
                        color: COLORS.navy,
                      }}
                      disabled={finalized || normalizedPlayers.length === 0}
                      title="Requires admin password."
                    >
                      {adjustOpen
                        ? "Close Leaderboard Edit"
                        : "Edit Leaderboard Scores"}
                    </button>

                    {/* payouts toggle */}
                    <button
                      onClick={togglePayoutsEnabled}
                      style={{
                        ...smallButtonStyle,
                        width: "100%",
                        background: payoutsEnabled ? COLORS.green : "#fff",
                        color: payoutsEnabled ? "white" : COLORS.navy,
                        border: `1px solid ${
                          payoutsEnabled ? COLORS.green : COLORS.navy
                        }`,
                        fontWeight: 900,
                      }}
                      disabled={normalizedPlayers.length === 0}
                      title="Requires admin password."
                    >
                      Enable Payouts: {payoutsEnabled ? "On" : "Off"}
                    </button>

                    {payoutsEnabled && (
                      <>
                        <button
                          onClick={() =>
                            requireAdmin(async () => {
                              setPayoutsOpen((v) => !v);
                            })
                          }
                          style={{
                            ...smallButtonStyle,
                            width: "100%",
                            background: "#fff",
                            border: `1px solid ${COLORS.navy}`,
                            color: COLORS.navy,
                          }}
                          disabled={normalizedPlayers.length === 0}
                          title="Requires admin password."
                        >
                          {payoutsOpen
                            ? "Close Payout Configuration"
                            : "Configure Payouts"}
                        </button>

                        {payoutsOpen && (
                          <div
                            style={{
                              border: `1px solid ${COLORS.border}`,
                              borderRadius: 12,
                              background: "#fff",
                              padding: 12,
                              display: "grid",
                              gap: 10,
                            }}
                          >
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: 900,
                                color: COLORS.navy,
                              }}
                            >
                              Payout Configuration
                            </div>

                            <label
                              style={{
                                fontSize: 12,
                                fontWeight: 900,
                                textAlign: "left",
                              }}
                            >
                              Buy-In ($)
                              <select
                                value={clampInt(
                                  payoutConfig?.buyInDollars ?? 0,
                                  0,
                                  50
                                )}
                                onChange={(e) =>
                                  updatePuttingDot(
                                    "payoutConfig.buyInDollars",
                                    clampInt(e.target.value, 0, 50)
                                  )
                                }
                                style={{
                                  ...inputStyle,
                                  width: "100%",
                                  marginTop: 6,
                                  background: "#fff",
                                }}
                              >
                                {Array.from({ length: 51 }, (_, i) => i).map(
                                  (n) => (
                                    <option key={n} value={n}>
                                      {n}
                                    </option>
                                  )
                                )}
                              </select>
                            </label>

                            <label
                              style={{
                                fontSize: 12,
                                fontWeight: 900,
                                textAlign: "left",
                              }}
                            >
                              League Fee (%)
                              <select
                                value={clampInt(
                                  payoutConfig?.leagueFeePct ?? 0,
                                  0,
                                  50
                                )}
                                onChange={(e) =>
                                  updatePuttingDot(
                                    "payoutConfig.leagueFeePct",
                                    clampInt(e.target.value, 0, 50)
                                  )
                                }
                                style={{
                                  ...inputStyle,
                                  width: "100%",
                                  marginTop: 6,
                                  background: "#fff",
                                }}
                              >
                                {Array.from({ length: 51 }, (_, i) => i).map(
                                  (n) => (
                                    <option key={n} value={n}>
                                      {n}
                                    </option>
                                  )
                                )}
                              </select>
                            </label>

                            <label
                              style={{
                                fontSize: 12,
                                fontWeight: 900,
                                textAlign: "left",
                              }}
                            >
                              Payout Mode
                              <select
                                value={payoutConfig?.mode ?? ""}
                                onChange={(e) =>
                                  updatePuttingDot(
                                    "payoutConfig.mode",
                                    e.target.value
                                  )
                                }
                                style={{
                                  ...inputStyle,
                                  width: "100%",
                                  background: "#fff",
                                  marginTop: 6,
                                }}
                              >
                                <option value="">Select mode…</option>
                                <option value="pool">By Pool</option>
                                <option value="collective">Collective</option>
                              </select>
                            </label>

                            <button
                              onClick={() =>
                                requireAdmin(async () => {
                                  const buyInOk = clampInt(
                                    payoutConfig?.buyInDollars,
                                    0,
                                    50
                                  );
                                  const feeOk = clampInt(
                                    payoutConfig?.leagueFeePct,
                                    0,
                                    50
                                  );
                                  const modeOk =
                                    payoutConfig?.mode === "pool" ||
                                    payoutConfig?.mode === "collective"
                                      ? payoutConfig.mode
                                      : "";

                                  if (!modeOk) {
                                    alert(
                                      'Select a payout mode ("By Pool" or "Collective").'
                                    );
                                    return;
                                  }

                                  await updatePutting({
                                    payoutConfig: {
                                      enabled: true,
                                      buyInDollars: buyInOk,
                                      leagueFeePct: feeOk,
                                      mode: modeOk,
                                      updatedAt: Date.now(),
                                    },
                                    payoutsPosted: {},
                                  });

                                  setPayoutsOpen(false);
                                  alert("Payouts saved ✅");
                                })
                              }
                              style={{
                                ...buttonStyle,
                                background: COLORS.green,
                                color: "white",
                                border: `1px solid ${COLORS.green}`,
                                width: "100%",
                              }}
                            >
                              Save Payout Configuration
                            </button>
                          </div>
                        )}

                        <button
                          onClick={postPayoutsToLeaderboard}
                          style={{
                            ...smallButtonStyle,
                            width: "100%",
                            background: "#fff",
                            border: `2px solid ${COLORS.red}`,
                            color: COLORS.red,
                            fontWeight: 900,
                          }}
                          disabled={!finalized || !payoutsEnabled}
                          title={
                            !finalized
                              ? "Only available after Finalize."
                              : "Requires admin password."
                          }
                        >
                          Post Payouts to Leaderboard
                        </button>
                      </>
                    )}

                    {adjustOpen && !finalized && (
                      <div
                        style={{
                          border: `1px solid ${COLORS.border}`,
                          borderRadius: 12,
                          background: "#fff",
                          padding: 10,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 12,
                            opacity: 0.8,
                            marginBottom: 10,
                          }}
                        >
                          Set a player’s{" "}
                          <strong>final leaderboard total</strong>. This creates
                          an adjustment. Disabled after Finalize.
                        </div>

                        <div style={{ display: "grid", gap: 8 }}>
                          {normalizedPlayers.map((p) => {
                            const base =
                              playMode === "simultaneous"
                                ? cumulativeBaseTotalForPlayer(p.id)
                                : seqCardRoundTotalsForPlayer(p.id).total;
                            const adj = Number(adjustments?.[p.id] ?? 0) || 0;
                            const total = base + adj;

                            return (
                              <div
                                key={p.id}
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "1fr auto",
                                  gap: 10,
                                  alignItems: "center",
                                  padding: "10px 12px",
                                  borderRadius: 12,
                                  border: `1px solid ${COLORS.border}`,
                                  background: COLORS.soft,
                                }}
                              >
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontWeight: 900 }}>
                                    {p.name}{" "}
                                    {poolMode === "split" ? (
                                      <span
                                        style={{ fontSize: 12, opacity: 0.7 }}
                                      >
                                        (
                                        {p.pool === "B"
                                          ? "B"
                                          : p.pool === "C"
                                          ? "C"
                                          : "A"}{" "}
                                        Pool)
                                      </span>
                                    ) : null}
                                  </div>

                                  <div
                                    style={{
                                      fontSize: 12,
                                      opacity: 0.75,
                                      marginTop: 2,
                                    }}
                                  >
                                    Base: <strong>{base}</strong> • Adj:{" "}
                                    <strong
                                      style={{
                                        color: adj ? COLORS.red : COLORS.navy,
                                      }}
                                    >
                                      {adj}
                                    </strong>{" "}
                                    • Final: <strong>{total}</strong>
                                  </div>
                                </div>

                                <div
                                  style={{
                                    display: "flex",
                                    gap: 8,
                                    alignItems: "center",
                                  }}
                                >
                                  <input
                                    type="number"
                                    value={String(total)}
                                    onChange={(e) =>
                                      setFinalLeaderboardTotal(
                                        p.id,
                                        e.target.value
                                      )
                                    }
                                    style={{
                                      ...inputStyle,
                                      width: 96,
                                      textAlign: "center",
                                      background: "#fff",
                                      fontWeight: 900,
                                    }}
                                    title="Requires admin password"
                                  />
                                  <button
                                    onClick={() => clearAdjustment(p.id)}
                                    style={{
                                      ...smallButtonStyle,
                                      background: "#fff",
                                      border: `1px solid ${COLORS.border}`,
                                      fontWeight: 900,
                                    }}
                                    title="Requires admin password"
                                  >
                                    Clear
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <button
                      onClick={resetPuttingLeague}
                      style={{
                        ...smallButtonStyle,
                        width: "100%",
                        background: "#fff",
                        border: `1px solid ${COLORS.border}`,
                      }}
                      title="Requires admin password."
                    >
                      Reset Putting League
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* CHECK-IN (always present in sequential; present until started in simultaneous) */}
          {(playMode === "sequential" || !roundStarted) && (
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
                  Player Check-In ({normalizedPlayers.length})
                </div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  {checkinOpen ? "Tap to collapse" : "Tap to expand"}
                </div>
              </div>

              {checkinOpen && (
                <div style={{ marginTop: 10 }}>
                  {playMode === "sequential" && !formatLocked ? (
                    <div style={{ fontSize: 12, opacity: 0.75 }}>
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
                      marginTop: 10,
                      opacity:
                        playMode === "sequential" &&
                        (!formatLocked || checkinLocked)
                          ? 0.6
                          : 1,
                    }}
                  >
                    <input
                      placeholder="Player name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      style={{ ...inputStyle, width: 240 }}
                      disabled={
                        finalized ||
                        (playMode === "sequential" &&
                          (!formatLocked || checkinLocked))
                      }
                    />

                    {poolMode === "split" ? (
                      <select
                        value={pool}
                        onChange={(e) => setPool(e.target.value)}
                        style={{
                          ...inputStyle,
                          width: 140,
                          background: "#fff",
                        }}
                        disabled={
                          finalized ||
                          (playMode === "sequential" &&
                            (!formatLocked || checkinLocked))
                        }
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
                      disabled={
                        finalized ||
                        (playMode === "simultaneous" && roundStarted) ||
                        (playMode === "sequential" &&
                          (!formatLocked || checkinLocked))
                      }
                    >
                      Add
                    </button>
                  </div>

                  {normalizedPlayers.length ? (
                    <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                      {normalizedPlayers.map((p) => (
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

                          {poolMode === "split" ? (
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
                          ) : (
                            <div style={{ fontSize: 12, opacity: 0.7 }}>
                              Combined Pool
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                      Add players as they arrive.
                    </div>
                  )}

                  {/* Simultaneous only: show card-mode buttons pre-start */}
                  {playMode === "simultaneous" && showCardModeButtons && (
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
                          fontSize: 12,
                          opacity: 0.85,
                          marginBottom: 10,
                        }}
                      >
                        Next: Create Round 1 cards
                      </div>

                      <div style={{ display: "grid", gap: 10 }}>
                        {/* ✅ CHANGE #2: Label updated */}
                        <button
                          onClick={setCardModeManual}
                          style={{
                            ...buttonStyle,
                            width: "100%",
                            background: "#fff",
                            border: `1px solid ${COLORS.navy}`,
                            color: COLORS.navy,
                          }}
                        >
                          Manually Create Card(s)
                        </button>

                        <button
                          onClick={randomizeRound1Cards}
                          style={{
                            ...buttonStyle,
                            width: "100%",
                            background: COLORS.navy,
                            color: "white",
                            border: `1px solid ${COLORS.navy}`,
                          }}
                        >
                          Randomize Cards
                        </button>

                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                          Cards are created using sizes 2–4 only (no 1-player
                          cards).
                        </div>

                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                          Current mode:{" "}
                          <strong>
                            {cardMode === "manual"
                              ? "Manual"
                              : cardMode === "random"
                              ? "Random"
                              : "Not chosen"}
                          </strong>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Sequential: Card Formation UI */}
                  {playMode === "sequential" && formatLocked && (
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
                          marginBottom: 6,
                        }}
                      >
                        Form a Card (Sequential Mode)
                      </div>

                      <div
                        style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}
                      >
                        Select 2–4 unassigned players, then create a card.
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
                          value={seqCardName}
                          onChange={(e) => setSeqCardName(e.target.value)}
                          style={{ ...inputStyle, width: 240 }}
                          disabled={finalized}
                        />

                        <button
                          onClick={createCardSequential}
                          style={{
                            ...smallButtonStyle,
                            background: COLORS.navy,
                            color: "white",
                            border: `1px solid ${COLORS.navy}`,
                          }}
                          disabled={finalized}
                        >
                          Create Card
                        </button>

                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                          Selected: <strong>{seqSelected.length}</strong> / 4
                          (min 2)
                        </div>
                      </div>

                      {/* ✅ CHANGE #1: Randomize Cards button ONLY appears after check-in is locked */}
                      {checkinLocked ? (
                        <button
                          onClick={randomizeSequentialCards}
                          style={{
                            ...smallButtonStyle,
                            width: "100%",
                            background: COLORS.navy,
                            color: "white",
                            border: `1px solid ${COLORS.navy}`,
                            marginBottom: 10,
                          }}
                          disabled={finalized || normalizedPlayers.length < 2}
                          title="Requires admin password. Only available after Lock Check-In."
                        >
                          Randomize Cards
                        </button>
                      ) : null}

                      {seqUnassignedPlayers.length === 0 ? (
                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                          No unassigned players available.
                        </div>
                      ) : (
                        <div style={{ display: "grid", gap: 8 }}>
                          {seqUnassignedPlayers.map((p) => {
                            const isSelected = seqSelected.includes(p.id);
                            return (
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
                                  cursor: "pointer",
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
                                    checked={isSelected}
                                    disabled={finalized}
                                    onChange={() => toggleSeqSelect(p.id)}
                                  />
                                  <div style={{ fontWeight: 900 }}>
                                    {p.name}
                                  </div>
                                </div>

                                {poolMode === "split" ? (
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
                                ) : (
                                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                                    Combined
                                  </div>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      )}

                      {!checkinLocked ? (
                        <div
                          style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}
                        >
                          Randomize Cards will appear after the admin locks
                          check-in.
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* CARDS */}
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
                {playMode === "sequential"
                  ? `Cards Formed (${seqCards.length})`
                  : `Cards — Round ${currentRound || 1}`}
              </div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {cardsOpen ? "Tap to collapse" : "Tap to expand"}
              </div>
            </div>

            {cardsOpen && (
              <div style={{ marginTop: 10 }}>
                {/* SIMULTANEOUS cards UI */}
                {playMode === "simultaneous" && (
                  <>
                    {!roundStarted && cardMode === "manual" ? (
                      <>
                        <div
                          style={{
                            fontSize: 12,
                            opacity: 0.8,
                            marginBottom: 10,
                          }}
                        >
                          Create Round 1 cards (2–4 players). Pools can be
                          mixed.
                        </div>

                        <div
                          style={{
                            border: `1px solid ${COLORS.border}`,
                            background: "#fff",
                            borderRadius: 12,
                            padding: 10,
                            marginBottom: 10,
                          }}
                        >
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
                              disabled={finalized}
                            />

                            <button
                              onClick={createCardSimultaneous}
                              style={{
                                ...smallButtonStyle,
                                background: COLORS.navy,
                                color: "white",
                                border: `1px solid ${COLORS.navy}`,
                              }}
                              disabled={finalized}
                            >
                              Create Card
                            </button>

                            <div style={{ fontSize: 12, opacity: 0.75 }}>
                              Selected:{" "}
                              <strong>{selectedForCard.length}</strong> / 4 (min
                              2)
                            </div>
                          </div>

                          <div style={{ display: "grid", gap: 8 }}>
                            {normalizedPlayers.map((p) => {
                              const isSelected = selectedForCard.includes(p.id);
                              const already = r1Cards.some((c) =>
                                (c.playerIds || []).includes(p.id)
                              );

                              return (
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
                                    background: already
                                      ? "#fafafa"
                                      : COLORS.soft,
                                    opacity: already ? 0.6 : 1,
                                    cursor: already ? "not-allowed" : "pointer",
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
                                      checked={isSelected}
                                      disabled={already || finalized}
                                      onChange={() => toggleSelectForCard(p.id)}
                                    />
                                    <div style={{ fontWeight: 900 }}>
                                      {p.name}
                                    </div>
                                  </div>

                                  {poolMode === "split" ? (
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
                                  ) : (
                                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                                      Combined
                                    </div>
                                  )}
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      </>
                    ) : roundStarted && currentRound >= 2 ? (
                      <div
                        style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}
                      >
                        Cards for Round {currentRound} are auto-created based on
                        Round {currentRound - 1} totals.
                      </div>
                    ) : !roundStarted ? (
                      <div
                        style={{
                          fontSize: 12,
                          opacity: 0.75,
                          marginBottom: 10,
                        }}
                      >
                        Choose Manual or Random cards above. Round 1 requires
                        all players be assigned to cards before starting.
                      </div>
                    ) : null}

                    <div style={{ display: "grid", gap: 8 }}>
                      {(Array.isArray(cardsByRound[String(currentRound || 1)])
                        ? cardsByRound[String(currentRound || 1)]
                        : []
                      ).map((c) => (
                        <div
                          key={c.id}
                          style={{
                            padding: "10px 12px",
                            borderRadius: 12,
                            border: `1px solid ${COLORS.border}`,
                            background: "#fff",
                          }}
                        >
                          <div style={{ fontWeight: 900, color: COLORS.navy }}>
                            {c.name}
                            {roundStarted && currentRound ? (
                              <span
                                style={{
                                  marginLeft: 8,
                                  fontSize: 12,
                                  opacity: 0.75,
                                }}
                              >
                                {submitted?.[String(currentRound)]?.[c.id]
                                  ? "✓ submitted"
                                  : "not submitted"}
                              </span>
                            ) : null}
                          </div>

                          <div style={{ marginTop: 6, fontSize: 14 }}>
                            {(c.playerIds || []).map((pid) => {
                              const p = normalizedPlayerById[pid];
                              if (!p) return null;
                              return (
                                <div
                                  key={pid}
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                  }}
                                >
                                  <span style={{ fontWeight: 800 }}>
                                    {p.name}
                                  </span>
                                  {poolMode === "split" ? (
                                    <span
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
                                    </span>
                                  ) : (
                                    <span
                                      style={{ fontSize: 12, opacity: 0.7 }}
                                    >
                                      Combined
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* SEQUENTIAL cards UI */}
                {playMode === "sequential" && (
                  <>
                    {seqCards.length === 0 ? (
                      <div style={{ fontSize: 12, opacity: 0.75 }}>
                        No cards yet. Use the Check-In section to form cards.
                      </div>
                    ) : (
                      <div style={{ display: "grid", gap: 10 }}>
                        {seqCards.map((c) => {
                          const nextRound = seqNextRoundForCard(c.id);
                          const done = nextRound === null;

                          return (
                            <div
                              key={c.id}
                              style={{
                                border: `1px solid ${COLORS.border}`,
                                borderRadius: 14,
                                background: "#fff",
                                padding: 12,
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  gap: 10,
                                }}
                              >
                                <div
                                  style={{
                                    fontWeight: 900,
                                    color: COLORS.navy,
                                  }}
                                >
                                  {c.name}{" "}
                                  <span style={{ fontSize: 12, opacity: 0.75 }}>
                                    {done
                                      ? "✓ completed"
                                      : `playing (next: Round ${nextRound})`}
                                  </span>
                                </div>
                              </div>

                              <div
                                style={{
                                  marginTop: 8,
                                  display: "grid",
                                  gap: 6,
                                }}
                              >
                                {(c.playerIds || []).map((pid) => {
                                  const p = normalizedPlayerById[pid];
                                  if (!p) return null;
                                  return (
                                    <div
                                      key={pid}
                                      style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                      }}
                                    >
                                      <span style={{ fontWeight: 800 }}>
                                        {p.name}
                                      </span>
                                      {poolMode === "split" ? (
                                        <span
                                          style={{
                                            fontSize: 12,
                                            fontWeight: 900,
                                            color: COLORS.navy,
                                          }}
                                        >
                                          {p.pool === "B"
                                            ? "B"
                                            : p.pool === "C"
                                            ? "C"
                                            : "A"}{" "}
                                          Pool
                                        </span>
                                      ) : (
                                        <span
                                          style={{ fontSize: 12, opacity: 0.7 }}
                                        >
                                          Combined
                                        </span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>

                              {!done && (
                                <div style={{ marginTop: 12 }}>
                                  <div
                                    style={{
                                      fontWeight: 900,
                                      color: COLORS.navy,
                                      marginBottom: 6,
                                    }}
                                  >
                                    Round {nextRound} scores (0–50)
                                  </div>

                                  <div style={{ display: "grid", gap: 8 }}>
                                    {(c.playerIds || []).map((pid) => {
                                      const p = normalizedPlayerById[pid];
                                      if (!p) return null;
                                      const currentVal =
                                        seqRoundScores?.[String(nextRound)]?.[
                                          c.id
                                        ]?.[pid];

                                      return (
                                        <div
                                          key={pid}
                                          style={{
                                            display: "flex",
                                            justifyContent: "space-between",
                                            alignItems: "center",
                                            gap: 10,
                                            padding: "10px 12px",
                                            borderRadius: 12,
                                            border: `1px solid ${COLORS.border}`,
                                            background: COLORS.soft,
                                          }}
                                        >
                                          <div style={{ fontWeight: 900 }}>
                                            {p.name}
                                          </div>
                                          <select
                                            value={
                                              currentVal === undefined ||
                                              currentVal === null ||
                                              currentVal === ""
                                                ? ""
                                                : String(currentVal)
                                            }
                                            disabled={finalized}
                                            onChange={(e) =>
                                              setSeqPlayerRoundScore(
                                                nextRound,
                                                c.id,
                                                pid,
                                                e.target.value === ""
                                                  ? ""
                                                  : Number(e.target.value)
                                              )
                                            }
                                            style={{
                                              ...inputStyle,
                                              width: 96,
                                              background: "#fff",
                                              fontWeight: 900,
                                              textAlign: "center",
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
                                    onClick={() =>
                                      submitSeqCardRound(c.id, nextRound)
                                    }
                                    disabled={finalized}
                                    style={{
                                      ...buttonStyle,
                                      width: "100%",
                                      marginTop: 10,
                                      background: COLORS.green,
                                      color: "white",
                                      border: `1px solid ${COLORS.green}`,
                                    }}
                                  >
                                    Submit Round {nextRound} Scores
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* SCOREKEEPER (SIMULTANEOUS ONLY) */}
          {playMode === "simultaneous" && roundStarted ? (
            <div
              style={{
                border: `1px solid ${COLORS.border}`,
                borderRadius: 14,
                background: "#fff",
                padding: 12,
                textAlign: "left",
                marginBottom: 12,
              }}
            >
              <div
                style={{ fontWeight: 900, color: COLORS.navy, marginBottom: 8 }}
              >
                Scorekeeper
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 10,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <select
                  value={activeCardId}
                  onChange={(e) => {
                    setActiveCardId(e.target.value);
                    setOpenStations({});
                  }}
                  style={{ ...inputStyle, width: 280, background: "#fff" }}
                >
                  <option value="">Select your card…</option>
                  {currentCards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>

                {activeCardId ? (
                  <button
                    onClick={() => {
                      setActiveCardId("");
                      setOpenStations({});
                    }}
                    style={{ ...smallButtonStyle, background: "#fff" }}
                  >
                    Change Card
                  </button>
                ) : null}
              </div>

              {activeCardId ? (
                (() => {
                  const card = currentCards.find((c) => c.id === activeCardId);
                  if (!card) return null;

                  const cardPlayers = (card.playerIds || [])
                    .map((pid) => normalizedPlayerById[pid])
                    .filter(Boolean);

                  const alreadySubmitted =
                    !!submitted?.[String(currentRound)]?.[card.id];

                  return (
                    <div style={{ marginTop: 14 }}>
                      <div
                        style={{
                          fontWeight: 900,
                          color: COLORS.navy,
                          marginBottom: 10,
                        }}
                      >
                        {card.name}{" "}
                        {alreadySubmitted ? (
                          <span style={{ color: COLORS.green, marginLeft: 8 }}>
                            (submitted)
                          </span>
                        ) : (
                          <span style={{ opacity: 0.6, marginLeft: 8 }}>
                            (in progress)
                          </span>
                        )}
                      </div>

                      <div style={{ display: "grid", gap: 10 }}>
                        {Array.from({ length: stations }, (_, i) => i + 1).map(
                          (stNum) => {
                            const open = !!openStations[stNum];

                            const stationRows = cardPlayers.map((p) => {
                              const made = madeFor(currentRound, stNum, p.id);
                              return {
                                id: p.id,
                                name: p.name,
                                pool: p.pool,
                                made,
                                pts: pointsForMade(made ?? 0),
                              };
                            });

                            return (
                              <div
                                key={stNum}
                                style={{
                                  border: `1px solid ${COLORS.border}`,
                                  borderRadius: 14,
                                  background: COLORS.soft,
                                  overflow: "hidden",
                                }}
                              >
                                <div
                                  onClick={() => toggleStation(stNum)}
                                  style={{
                                    padding: "12px 12px",
                                    cursor: "pointer",
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    gap: 10,
                                  }}
                                >
                                  <div
                                    style={{
                                      fontWeight: 900,
                                      color: COLORS.navy,
                                    }}
                                  >
                                    Station {stNum}
                                  </div>
                                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                                    {open ? "Tap to collapse" : "Tap to expand"}
                                  </div>
                                </div>

                                {open && (
                                  <div
                                    style={{ padding: 12, background: "#fff" }}
                                  >
                                    <div
                                      style={{
                                        fontSize: 12,
                                        opacity: 0.75,
                                        marginBottom: 10,
                                      }}
                                    >
                                      Blank means “not entered yet.” (4=5pts,
                                      3=3pts, 2=2pts, 1=1pt, 0=0)
                                    </div>

                                    <div style={{ display: "grid", gap: 8 }}>
                                      {stationRows.map((row) => (
                                        <div
                                          key={row.id}
                                          style={{
                                            display: "grid",
                                            gridTemplateColumns:
                                              "1fr auto auto",
                                            alignItems: "center",
                                            gap: 10,
                                            padding: "10px 12px",
                                            borderRadius: 12,
                                            border: `1px solid ${COLORS.border}`,
                                            background: COLORS.soft,
                                            opacity: alreadySubmitted
                                              ? 0.75
                                              : 1,
                                            minWidth: 0,
                                          }}
                                        >
                                          <div style={{ minWidth: 0 }}>
                                            <div
                                              style={{
                                                fontWeight: 900,
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                              }}
                                            >
                                              {row.name}{" "}
                                              {poolMode === "split" ? (
                                                <span
                                                  style={{
                                                    fontSize: 12,
                                                    opacity: 0.75,
                                                  }}
                                                >
                                                  (
                                                  {row.pool === "B"
                                                    ? "B"
                                                    : row.pool === "C"
                                                    ? "C"
                                                    : "A"}
                                                  )
                                                </span>
                                              ) : null}
                                            </div>
                                          </div>

                                          <select
                                            value={
                                              row.made === null
                                                ? ""
                                                : String(row.made)
                                            }
                                            disabled={
                                              alreadySubmitted || finalized
                                            }
                                            onChange={(e) =>
                                              setMade(
                                                currentRound,
                                                stNum,
                                                row.id,
                                                e.target.value === ""
                                                  ? ""
                                                  : Number(e.target.value)
                                              )
                                            }
                                            style={{
                                              ...inputStyle,
                                              width: 84,
                                              background: "#fff",
                                              fontWeight: 900,
                                              textAlign: "center",
                                              justifySelf: "end",
                                            }}
                                          >
                                            <option value="">—</option>
                                            {[0, 1, 2, 3, 4].map((m) => (
                                              <option key={m} value={m}>
                                                {m}
                                              </option>
                                            ))}
                                          </select>

                                          <div
                                            style={{
                                              textAlign: "right",
                                              fontWeight: 900,
                                              color: COLORS.navy,
                                              justifySelf: "end",
                                              whiteSpace: "nowrap",
                                            }}
                                          >
                                            {row.pts} pts
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          }
                        )}
                      </div>

                      <div style={{ marginTop: 14 }}>
                        <div
                          style={{
                            fontWeight: 900,
                            color: COLORS.navy,
                            marginBottom: 8,
                          }}
                        >
                          Round {currentRound} Totals (This Card)
                        </div>
                        <div style={{ display: "grid", gap: 8 }}>
                          {cardPlayers.map((p) => {
                            const total = roundTotalForPlayer(
                              currentRound,
                              p.id
                            );
                            return (
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
                                <div style={{ fontWeight: 900 }}>{p.name}</div>
                                <div
                                  style={{
                                    fontWeight: 900,
                                    color: COLORS.navy,
                                  }}
                                >
                                  {total} pts
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <div style={{ marginTop: 14 }}>
                        <button
                          onClick={() => submitCardScores(card.id)}
                          disabled={alreadySubmitted || finalized}
                          style={{
                            ...buttonStyle,
                            width: "100%",
                            background: alreadySubmitted
                              ? "#ddd"
                              : COLORS.green,
                            color: alreadySubmitted ? "#444" : "white",
                            border: `1px solid ${
                              alreadySubmitted ? "#ddd" : COLORS.green
                            }`,
                          }}
                        >
                          {alreadySubmitted
                            ? "Card Submitted (Locked)"
                            : "Submit Card Scores"}
                        </button>

                        <div
                          style={{
                            marginTop: 8,
                            fontSize: 12,
                            opacity: 0.75,
                            textAlign: "center",
                          }}
                        >
                          Submitting locks this card for this round.
                        </div>
                      </div>
                    </div>
                  );
                })()
              ) : (
                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                  Select your card to start scoring.
                </div>
              )}
            </div>
          ) : null}

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
                Leaderboards{" "}
                {playMode === "sequential"
                  ? "(Only Submitted Rounds)"
                  : "(Cumulative)"}{" "}
                {" — "}
                {poolMode === "combined" ? "Combined Pool" : "Split Pool"}
              </span>
              <span style={{ fontSize: 12, opacity: 0.75 }}>
                {leaderboardsOpen ? "Tap to hide" : "Tap to show"}
              </span>
            </div>

            {leaderboardsOpen && (
              <div style={{ display: "grid", gap: 10 }}>
                {(poolMode === "combined" ? ["A"] : ["A", "B", "C"]).map(
                  (k) => {
                    const label =
                      poolMode === "combined"
                        ? "All Players"
                        : k === "A"
                        ? "A Pool"
                        : k === "B"
                        ? "B Pool"
                        : "C Pool";

                    const rows = leaderboardData[k] || [];
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
                                const isPaid =
                                  payoutsEnabled &&
                                  finalized &&
                                  hasPostedPayouts &&
                                  Number(r.payoutDollars || 0) > 0;

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
                                      flexWrap: "wrap",
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
                                          background: isPaid
                                            ? COLORS.green
                                            : COLORS.navy,
                                          flexShrink: 0,
                                        }}
                                      >
                                        {place}
                                      </div>

                                      <div style={{ minWidth: 0 }}>
                                        {/* LINE 1 — Name */}
                                        <div
                                          style={{
                                            fontWeight: 900,
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

                                          {payoutsEnabled &&
                                          finalized &&
                                          hasPostedPayouts &&
                                          Number(r.payoutDollars || 0) > 0 ? (
                                            <span
                                              style={{
                                                fontSize: 12,
                                                marginLeft: 10,
                                                fontWeight: 900,
                                                color: COLORS.green,
                                              }}
                                            >
                                              ${Number(r.payoutDollars || 0)}
                                            </span>
                                          ) : null}
                                        </div>

                                        {/* LINE 2 — Through Round */}
                                        {playMode === "sequential" ? (
                                          <div
                                            style={{
                                              fontSize: 12,
                                              opacity: 0.75,
                                              marginTop: 2,
                                              whiteSpace: "nowrap",
                                              overflow: "hidden",
                                              textOverflow: "ellipsis",
                                            }}
                                          >
                                            (through round {r.throughRound || 0}
                                            )
                                          </div>
                                        ) : null}
                                      </div>
                                    </div>

                                    <div
                                      style={{
                                        fontWeight: 900,
                                        color: COLORS.navy,
                                        whiteSpace: "nowrap",
                                        marginLeft: "auto",
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
                  }
                )}
              </div>
            )}
          </div>

          <div
            style={{
              marginTop: 14,
              fontSize: 12,
              opacity: 0.55,
              textAlign: "center",
            }}
          >
            {APP_VERSION} Beta• Developed by Eli Morgan
          </div>
        </div>
      </div>
    </div>
  );
}
