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
const APP_VERSION = "v1.7.0";

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
  while (remaining > 0 && frac.length) {
    amounts[frac[idx].i] += 1;
    remaining -= 1;
    idx += 1;
    if (idx >= frac.length) idx = 0;
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

  // Putting league stored data
  const [putting, setPutting] = useState({
    settings: {
      // shared config
      stations: 1,
      rounds: 1,
      finalized: false,

      // mode selectors
      playMode: "simultaneous", // "simultaneous" | "sequential"
      poolMode: "split", // "split" | "combined"

      // simultaneous (legacy)
      locked: false,
      currentRound: 0,
      cardMode: "", // "" | "manual" | "random"

      // sequential
      seqFormatLocked: false, // “Lock Format & Open Check-In”
      seqCheckInLocked: false, // admin locks check-in later
    },

    // shared
    players: [],
    adjustments: {},
    payoutConfig: { ...DEFAULT_PAYOUT_CONFIG },
    payoutsPosted: {},

    // simultaneous
    cardsByRound: {},
    scores: {}, // per-station
    submitted: {},

    // sequential
    seqCards: [], // [{id,name,playerIds:[]}]
    seqRoundScores: {}, // { [round]: { [playerId]: number } }
    seqSubmitted: {}, // { [round]: { [cardId]: true } }
    seqPlayerRounds: {}, // { [playerId]: maxSubmittedRound }
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

  // Manual card creation UI (simultaneous Round 1)
  const [selectedForCard, setSelectedForCard] = useState([]);
  const [cardName, setCardName] = useState("");

  // Scorekeeper selection UI (simultaneous)
  const [activeCardId, setActiveCardId] = useState("");
  const [openStations, setOpenStations] = useState({});

  // Sequential UI
  const [seqSelectedForCard, setSeqSelectedForCard] = useState([]);
  const [seqCardName, setSeqCardName] = useState("");
  const [seqCardsOpen, setSeqCardsOpen] = useState(true);
  const [seqOpenCardIds, setSeqOpenCardIds] = useState({}); // {cardId: true}

  // ✅ Admin unlock window (device/tab specific)
  const [adminOkUntil, setAdminOkUntil] = useState(0);

  // -------- Helpers (computed) --------
  const settings = putting.settings || {};
  const playMode =
    settings.playMode === "sequential" ? "sequential" : "simultaneous";
  const poolMode = settings.poolMode === "combined" ? "combined" : "split";

  const stations = Math.max(1, Math.min(18, Number(settings.stations || 1)));
  const totalRounds = Math.max(1, Math.min(5, Number(settings.rounds || 1)));
  const finalized = !!settings.finalized;

  // simultaneous state
  const simLocked = !!settings.locked;
  const currentRound = Number(settings.currentRound || 0);
  const cardMode = String(settings.cardMode || "");
  const roundStartedSim =
    playMode === "simultaneous" && simLocked && currentRound >= 1;

  // sequential state
  const seqFormatLocked = !!settings.seqFormatLocked;
  const seqCheckInLocked = !!settings.seqCheckInLocked;
  const seqActive = playMode === "sequential" && seqFormatLocked && !finalized;

  const players = Array.isArray(putting.players) ? putting.players : [];
  const adjustments =
    putting.adjustments && typeof putting.adjustments === "object"
      ? putting.adjustments
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

  // simultaneous data
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

  const r1Cards = Array.isArray(cardsByRound["1"]) ? cardsByRound["1"] : [];
  const currentCards = Array.isArray(cardsByRound[String(currentRound)])
    ? cardsByRound[String(currentRound)]
    : [];

  // sequential data
  const seqCards = Array.isArray(putting.seqCards) ? putting.seqCards : [];
  const seqRoundScores =
    putting.seqRoundScores && typeof putting.seqRoundScores === "object"
      ? putting.seqRoundScores
      : {};
  const seqSubmitted =
    putting.seqSubmitted && typeof putting.seqSubmitted === "object"
      ? putting.seqSubmitted
      : {};
  const seqPlayerRounds =
    putting.seqPlayerRounds && typeof putting.seqPlayerRounds === "object"
      ? putting.seqPlayerRounds
      : {};

  const playerById = useMemo(() => {
    const map = {};
    players.forEach((p) => (map[p.id] = p));
    return map;
  }, [players]);

  // After simultaneous league starts, collapse admin tools/check-in by default (but NOT in sequential)
  useEffect(() => {
    if (roundStartedSim) {
      setCheckinOpen(false);
      setSetupOpen(false);
      setPayoutsOpen(false);
    }
  }, [roundStartedSim]);

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

  function roundTotalForPlayerSim(roundNum, playerId) {
    let total = 0;
    for (let s = 1; s <= stations; s++) {
      const made = madeFor(roundNum, s, playerId);
      total += pointsForMade(made ?? 0);
    }
    return total;
  }

  function cumulativeBaseTotalForPlayerSim(playerId) {
    let total = 0;
    for (let r = 1; r <= totalRounds; r++) {
      total += roundTotalForPlayerSim(r, playerId);
    }
    return total;
  }

  // sequential totals
  function roundsThroughForPlayerSeq(playerId) {
    const n = Number(seqPlayerRounds?.[playerId] || 0);
    return Math.max(0, Math.min(totalRounds, n));
  }

  function cumulativeBaseTotalForPlayerSeq(playerId) {
    const through = roundsThroughForPlayerSeq(playerId);
    let total = 0;
    for (let r = 1; r <= through; r++) {
      const rr = seqRoundScores?.[String(r)] || {};
      const val = rr?.[playerId];
      total += Number(val || 0);
    }
    return total;
  }

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
          players: [],
          rounds: [],
          roundHistory: [],
          defendMode: {
            enabled: false,
            scope: "podium",
            durationType: "weeks",
            weeks: 2,
            tagExpiresAt: {},
          },
          puttingLeague: {
            settings: {
              stations: 1,
              rounds: 1,
              finalized: false,

              playMode: "simultaneous",
              poolMode: "split",

              locked: false,
              currentRound: 0,
              cardMode: "",

              seqFormatLocked: false,
              seqCheckInLocked: false,
            },

            players: [],
            adjustments: {},
            payoutConfig: { ...DEFAULT_PAYOUT_CONFIG },
            payoutsPosted: {},

            cardsByRound: {},
            scores: {},
            submitted: {},

            seqCards: [],
            seqRoundScores: {},
            seqSubmitted: {},
            seqPlayerRounds: {},
          },
        });
      }

      unsub = onSnapshot(
        leagueRef,
        (s) => {
          const data = s.data() || {};
          const pl = data.puttingLeague || {};

          const safe = {
            ...pl,
            settings: {
              stations: 1,
              rounds: 1,
              finalized: false,

              playMode: "simultaneous",
              poolMode: "split",

              locked: false,
              currentRound: 0,
              cardMode: "",

              seqFormatLocked: false,
              seqCheckInLocked: false,

              ...(pl.settings || {}),
            },

            players: Array.isArray(pl.players) ? pl.players : [],
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

            // simultaneous
            cardsByRound:
              pl.cardsByRound && typeof pl.cardsByRound === "object"
                ? pl.cardsByRound
                : {},
            scores: pl.scores && typeof pl.scores === "object" ? pl.scores : {},
            submitted:
              pl.submitted && typeof pl.submitted === "object"
                ? pl.submitted
                : {},

            // sequential
            seqCards: Array.isArray(pl.seqCards) ? pl.seqCards : [],
            seqRoundScores:
              pl.seqRoundScores && typeof pl.seqRoundScores === "object"
                ? pl.seqRoundScores
                : {},
            seqSubmitted:
              pl.seqSubmitted && typeof pl.seqSubmitted === "object"
                ? pl.seqSubmitted
                : {},
            seqPlayerRounds:
              pl.seqPlayerRounds && typeof pl.seqPlayerRounds === "object"
                ? pl.seqPlayerRounds
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

  // ---------- MODE / POOL TOGGLES ----------
  async function setPlayMode(nextMode) {
    const mode = nextMode === "sequential" ? "sequential" : "simultaneous";
    await updatePutting({
      settings: {
        ...settings,
        playMode: mode,
      },
    });

    // local UI resets that are harmless
    setActiveCardId("");
    setOpenStations({});
    setSelectedForCard([]);
    setCardName("");
    setSeqSelectedForCard([]);
    setSeqCardName("");
  }

  async function setPoolMode(nextPoolMode) {
    const pm = nextPoolMode === "combined" ? "combined" : "split";

    await updatePutting({
      settings: {
        ...settings,
        poolMode: pm,
      },
    });
  }

  // ---------- SIMULTANEOUS: card/round helpers ----------
  function validateRound1Cards(cards) {
    if (!Array.isArray(cards) || cards.length === 0) {
      return { ok: false, reason: "No cards created yet." };
    }

    const allIds = new Set(players.map((p) => p.id));
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
    const arr = [...players];
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
    const ranked = [...players]
      .map((p) => ({ id: p.id, total: roundTotalForPlayerSim(roundNum, p.id) }))
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

  // ---------- PLAYER CHECK-IN (shared UI, behavior depends on mode + pool mode) ----------
  async function addPlayer() {
    if (finalized) {
      alert("Scores are finalized. Reset to start a new league.");
      return;
    }

    // gating depends on mode
    if (playMode === "simultaneous") {
      if (roundStartedSim) return;
    } else {
      // sequential: only allow add when format locked/open AND check-in not locked
      if (!seqFormatLocked) return;
      if (seqCheckInLocked) return;
    }

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
      pool: poolMode === "combined" ? "A" : pool || "A",
    };

    await updatePutting({ players: [...players, newPlayer] });

    setName("");
    setPool("A");
  }

  // ---------- SIMULTANEOUS: manual cards ----------
  function toggleSelectForCard(playerId) {
    setSelectedForCard((prev) =>
      prev.includes(playerId)
        ? prev.filter((x) => x !== playerId)
        : [...prev, playerId]
    );
  }

  async function setCardModeManual() {
    if (finalized || roundStartedSim) return;
    await updatePutting({ settings: { ...settings, cardMode: "manual" } });
    setCardsOpen(true);
  }

  async function randomizeRound1Cards() {
    if (finalized || roundStartedSim) return;

    if (players.length < 2) {
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

  async function createCardSim() {
    if (finalized) return;
    if (roundStartedSim) {
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
  }

  async function beginRoundOneSimultaneous() {
    if (finalized) return;

    await requireAdmin(async () => {
      if (players.length < 2)
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
          // sequential flags should be off when running simultaneous
          seqFormatLocked: false,
          seqCheckInLocked: false,
          playMode: "simultaneous",
        },
        submitted: {
          ...(putting.submitted || {}),
          1: putting.submitted?.["1"] || {},
        },
      });

      setSetupOpen(false);
      setCheckinOpen(false);
      setCardsOpen(true);
      setPayoutsOpen(false);
      window.scrollTo(0, 0);
    });
  }

  async function beginNextRoundSimultaneous() {
    if (finalized) return;

    await requireAdmin(async () => {
      if (!simLocked || currentRound < 1)
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
    if (!simLocked || currentRound < 1)
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

  // ---------- SEQUENTIAL: lock format, check-in lock, card creation, per-round submits ----------
  async function lockFormatAndOpenCheckInSequential() {
    if (finalized) return;
    await requireAdmin(async () => {
      await updatePutting({
        settings: {
          ...settings,
          playMode: "sequential",
          stations,
          rounds: totalRounds,
          seqFormatLocked: true,
          seqCheckInLocked: false,
          // ensure simultaneous is not running
          locked: false,
          currentRound: 0,
          cardMode: "",
        },
      });
      setCheckinOpen(true);
      setCardsOpen(true);
      alert("Format locked. Check-in is now open.");
    });
  }

  async function lockCheckInSequential() {
    if (finalized) return;
    await requireAdmin(async () => {
      if (!seqFormatLocked) return alert("Lock the format first.");
      await updatePutting({
        settings: {
          ...settings,
          seqCheckInLocked: true,
        },
      });
      alert("Check-in locked.");
    });
  }

  function toggleSeqSelect(playerId) {
    setSeqSelectedForCard((prev) =>
      prev.includes(playerId)
        ? prev.filter((x) => x !== playerId)
        : [...prev, playerId]
    );
  }

  function seqAssignedPlayerIds() {
    const set = new Set();
    seqCards.forEach((c) => (c.playerIds || []).forEach((id) => set.add(id)));
    return set;
  }

  async function createCardSequential() {
    if (finalized) return;
    if (!seqFormatLocked) return alert("Lock format & open check-in first.");
    if (seqSelectedForCard.length < 2)
      return alert("Select at least 2 players.");
    if (seqSelectedForCard.length > 4) return alert("Max 4 players per card.");

    const assigned = seqAssignedPlayerIds();
    const overlaps = seqSelectedForCard.some((id) => assigned.has(id));
    if (overlaps)
      return alert("One or more selected players are already on a card.");

    const newCard = {
      id: uid(),
      name: (seqCardName || "").trim() || `Card ${seqCards.length + 1}`,
      playerIds: [...seqSelectedForCard],
    };

    await updatePutting({
      seqCards: [...seqCards, newCard],
    });

    setSeqSelectedForCard([]);
    setSeqCardName("");
  }

  function nextRoundForCard(cardId) {
    for (let r = 1; r <= totalRounds; r++) {
      const sub = seqSubmitted?.[String(r)] || {};
      if (!sub?.[cardId]) return r;
    }
    return null; // done
  }

  function seqScoreValue(roundNum, playerId) {
    const rr = seqRoundScores?.[String(roundNum)] || {};
    const v = rr?.[playerId];
    if (v === undefined || v === null || v === "") return "";
    const n = Number(v);
    return Number.isNaN(n) ? "" : n;
  }

  async function setSeqRoundScore(roundNum, playerId, value) {
    if (finalized) return;
    if (!seqFormatLocked) return;

    const v =
      value === "" || value === null || value === undefined
        ? ""
        : clampInt(value, 0, 50);

    const path = `puttingLeague.seqRoundScores.${String(roundNum)}.${playerId}`;
    if (v === "") {
      await updateDoc(leagueRef, { [path]: deleteField() });
      return;
    }
    await updateDoc(leagueRef, { [path]: v });
  }

  function isSeqCardRoundFullyFilled(card, roundNum) {
    const ids = card?.playerIds || [];
    if (!ids.length) return false;

    const rr = seqRoundScores?.[String(roundNum)] || {};
    for (const pid of ids) {
      const raw = rr?.[pid];
      if (raw === undefined || raw === null || raw === "") return false;
    }
    return true;
  }

  async function submitSeqCardRound(cardId) {
    if (finalized) return;
    const card = seqCards.find((c) => c.id === cardId);
    if (!card) return;

    const roundNum = nextRoundForCard(cardId);
    if (!roundNum) return;

    if (!isSeqCardRoundFullyFilled(card, roundNum)) {
      alert(
        "Missing scores. Enter a score (0–50) for every player on this card."
      );
      return;
    }

    await requireAdmin(async () => {
      // mark card submitted for that round
      await updatePutting({
        seqSubmitted: {
          ...seqSubmitted,
          [String(roundNum)]: {
            ...(seqSubmitted?.[String(roundNum)] || {}),
            [cardId]: true,
          },
        },
        seqPlayerRounds: {
          ...seqPlayerRounds,
          ...(card.playerIds || []).reduce((acc, pid) => {
            const prev = Number(seqPlayerRounds?.[pid] || 0);
            acc[pid] = Math.max(prev, roundNum);
            return acc;
          }, {}),
        },
      });

      alert(
        roundNum === totalRounds
          ? "Final round submitted ✅"
          : `Round ${roundNum} submitted ✅`
      );
    });
  }

  async function finalizeLeaderboardSequential() {
    if (finalized) return;
    await requireAdmin(async () => {
      await updatePutting({
        settings: {
          ...settings,
          finalized: true,
        },
      });
      alert("Leaderboard finalized (locked).");
    });
  }

  // -------- Admin leaderboard adjustment tool (shared, applies to whichever mode is active) --------
  async function openAdjustmentsEditor() {
    if (finalized)
      return alert("Leaderboards are finalized. Adjustments are locked.");
    await requireAdmin(async () => setAdjustOpen((v) => !v));
  }

  async function setFinalLeaderboardTotal(playerId, desiredFinalTotal) {
    if (finalized) return;

    await requireAdmin(async () => {
      const base =
        playMode === "sequential"
          ? cumulativeBaseTotalForPlayerSeq(playerId)
          : cumulativeBaseTotalForPlayerSim(playerId);

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

  // -------- Scorekeeper (SIMULTANEOUS ONLY) --------
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

  // -------- LEADERBOARDS (mode-aware + pool-mode-aware) --------
  const leaderboardGroups = useMemo(() => {
    const groups =
      poolMode === "combined" ? { ALL: [] } : { A: [], B: [], C: [] };

    players.forEach((p) => {
      const base =
        playMode === "sequential"
          ? cumulativeBaseTotalForPlayerSeq(p.id)
          : cumulativeBaseTotalForPlayerSim(p.id);

      const through =
        playMode === "sequential"
          ? roundsThroughForPlayerSeq(p.id)
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
        throughRound: playMode === "sequential" ? through : null,
      };

      if (poolMode === "combined") {
        groups.ALL.push(row);
      } else {
        if (p.pool === "B") groups.B.push(row);
        else if (p.pool === "C") groups.C.push(row);
        else groups.A.push(row);
      }
    });

    Object.keys(groups).forEach((k) =>
      groups[k].sort((a, b) => b.total - a.total)
    );
    return groups;
  }, [
    players,
    playMode,
    poolMode,
    scores,
    seqRoundScores,
    seqPlayerRounds,
    stations,
    totalRounds,
    adjustments,
    payoutsPosted,
  ]);

  // ---- payouts computation (adapts to combined pool) ----
  function computeAllPayoutsDollars() {
    if (!payoutConfig) return { ok: false, reason: "No payout configuration." };
    if (!payoutConfig.enabled)
      return { ok: false, reason: "Payouts are disabled." };

    const buyIn = clampInt(payoutConfig.buyInDollars, 0, 50);
    const feePct = clampInt(payoutConfig.leagueFeePct, 0, 50);
    let mode = payoutConfig.mode;

    if (!players.length) return { ok: false, reason: "No players checked in." };

    // If combined pool, collective mode is not meaningful; force pool mode
    if (poolMode === "combined") mode = "pool";

    const totalPotDollars = buyIn * players.length;
    const feeDollars = Math.round((totalPotDollars * feePct) / 100);
    const potAfterFeeDollars = Math.max(0, totalPotDollars - feeDollars);

    if (potAfterFeeDollars <= 0)
      return { ok: false, reason: "Pot after fee is $0." };

    const pools =
      poolMode === "combined"
        ? {
            ALL: (leaderboardGroups.ALL || []).map((r) => ({
              id: r.id,
              total: r.total,
              name: r.name,
            })),
          }
        : {
            A: (leaderboardGroups.A || []).map((r) => ({
              id: r.id,
              total: r.total,
              name: r.name,
            })),
            B: (leaderboardGroups.B || []).map((r) => ({
              id: r.id,
              total: r.total,
              name: r.name,
            })),
            C: (leaderboardGroups.C || []).map((r) => ({
              id: r.id,
              total: r.total,
              name: r.name,
            })),
          };

    if (mode === "pool") {
      const payouts = {};

      const poolPotDollars = (poolCount) => {
        const poolTotal = buyIn * poolCount;
        const poolFee = Math.round((poolTotal * feePct) / 100);
        return Math.max(0, poolTotal - poolFee);
      };

      const doPool = (key) => {
        const rows = pools[key] || [];
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

      Object.keys(pools).forEach((k) => doPool(k));

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

    // collective only when split pools
    const countA = (pools.A || []).length;
    const countB = (pools.B || []).length;
    const countC = (pools.C || []).length;

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

  const hasPostedPayouts =
    payoutsEnabled && Object.keys(payoutsPosted || {}).length > 0;

  // ---- Missing league guard ----
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

  // ---------- Mode-aware “status” block ----------
  let statusLine = "";
  if (finalized) statusLine = "FINALIZED (locked)";
  else if (playMode === "simultaneous") {
    statusLine = roundStartedSim
      ? `Round ${currentRound} of ${totalRounds}`
      : "Not started";
  } else {
    statusLine = seqFormatLocked ? "Check-in open (Sequential)" : "Not started";
    if (seqFormatLocked && seqCheckInLocked)
      statusLine = "Check-in locked (Sequential)";
  }

  // ---------- Simultaneous admin stats ----------
  const submitStatsSim = roundStartedSim
    ? submittedCountForRound(currentRound)
    : { submitted: 0, total: 0 };
  const missingCardsThisRoundSim = roundStartedSim
    ? missingCardsForRound(currentRound)
    : [];

  const canBeginNextRound =
    roundStartedSim &&
    !finalized &&
    currentRound < totalRounds &&
    allCardsSubmittedForRound(currentRound);

  const canFinalize =
    roundStartedSim &&
    !finalized &&
    currentRound === totalRounds &&
    allCardsSubmittedForRound(currentRound);

  const showCardModeButtons =
    playMode === "simultaneous" &&
    !roundStartedSim &&
    !finalized &&
    players.length >= 2;

  // ---------- Render ----------
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
              {playMode === "simultaneous"
                ? "Simultaneous Mode"
                : "Sequential Mode"}
            </span>
            <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
              {poolMode === "combined" ? "Combined Pool" : "Split Pool"}
              {" • "}
              {statusLine}
            </div>
            {finalized ? (
              <div style={{ marginTop: 6, color: COLORS.red, fontWeight: 900 }}>
                FINALIZED (locked)
              </div>
            ) : null}
          </div>

          {/* Simultaneous-only admin status */}
          {playMode === "simultaneous" && roundStartedSim && (
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 14 }}>
              <div>
                Admin Status: Cards submitted this round —{" "}
                <strong>
                  {submitStatsSim.submitted} / {submitStatsSim.total}
                </strong>
              </div>

              {missingCardsThisRoundSim.length > 0 ? (
                <div style={{ marginTop: 6 }}>
                  Waiting on:{" "}
                  <strong style={{ color: COLORS.red }}>
                    {missingCardsThisRoundSim.map((c) => c.name).join(", ")}
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
                  {/* Mode selector (restored simple selector style) */}
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
                      disabled={finalized || roundStartedSim || seqFormatLocked}
                      onChange={(e) => setPlayMode(e.target.value)}
                      style={{
                        ...inputStyle,
                        width: "100%",
                        background: "#fff",
                      }}
                      title={
                        finalized
                          ? "Finalized"
                          : roundStartedSim || seqFormatLocked
                          ? "Format is locked"
                          : "Choose Simultaneous or Sequential"
                      }
                    >
                      <option value="simultaneous">
                        Simultaneous Stations
                      </option>
                      <option value="sequential">Sequential Stations</option>
                    </select>
                    {(roundStartedSim || seqFormatLocked) && (
                      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                        Format is locked for this league run.
                      </div>
                    )}
                  </div>

                  {/* Pool mode selector */}
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
                      disabled={
                        finalized ||
                        roundStartedSim ||
                        seqFormatLocked ||
                        players.length > 0
                      }
                      onChange={(e) => setPoolMode(e.target.value)}
                      style={{
                        ...inputStyle,
                        width: "100%",
                        background: "#fff",
                      }}
                      title={
                        players.length > 0
                          ? "Pool mode can only be changed before check-in starts."
                          : "Split = A/B/C pools. Combined = one leaderboard."
                      }
                    >
                      <option value="split">Split Pool (A/B/C)</option>
                      <option value="combined">
                        Combined Pool (All players)
                      </option>
                    </select>
                    {players.length > 0 && (
                      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                        Pool mode is locked once players are checked in.
                      </div>
                    )}
                  </div>

                  {/* Stations (1–18) */}
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 900,
                        color: COLORS.navy,
                        marginBottom: 6,
                      }}
                    >
                      Stations
                    </div>
                    <select
                      value={stations}
                      disabled={finalized || roundStartedSim || seqFormatLocked}
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
                      {Array.from({ length: 18 }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Rounds */}
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
                      disabled={finalized || roundStartedSim || seqFormatLocked}
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

                  {/* Mode-specific start buttons */}
                  {playMode === "simultaneous" ? (
                    !roundStartedSim ? (
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
                        title="Requires admin password. Locks format and begins Round 1."
                      >
                        Begin Round 1 (Lock Format)
                      </button>
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.75 }}>
                        Format locked (Simultaneous).
                      </div>
                    )
                  ) : !seqFormatLocked ? (
                    <button
                      onClick={lockFormatAndOpenCheckInSequential}
                      style={{
                        ...buttonStyle,
                        width: "100%",
                        background: COLORS.green,
                        color: "white",
                        border: `1px solid ${COLORS.green}`,
                      }}
                      disabled={finalized}
                      title="Requires admin password. Locks format and opens check-in."
                    >
                      Lock Format and Open Check-In
                    </button>
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.75 }}>
                      Format locked (Sequential).
                    </div>
                  )}

                  {/* Simultaneous-only next/finalize */}
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
                      title="Requires admin password. Only appears after every card submits."
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
                      title="Only available after all cards submit on final round."
                    >
                      Finalize Scores (Lock)
                    </button>
                  )}

                  {/* Sequential-only check-in lock + finalize */}
                  {playMode === "sequential" &&
                    seqFormatLocked &&
                    !seqCheckInLocked &&
                    !finalized && (
                      <button
                        onClick={lockCheckInSequential}
                        style={{
                          ...buttonStyle,
                          width: "100%",
                          background: COLORS.navy,
                          color: "white",
                          border: `1px solid ${COLORS.navy}`,
                        }}
                        title="Requires admin password. Prevents new players from checking in."
                      >
                        Lock Check-In
                      </button>
                    )}

                  {playMode === "sequential" &&
                    seqFormatLocked &&
                    !finalized && (
                      <button
                        onClick={finalizeLeaderboardSequential}
                        style={{
                          ...buttonStyle,
                          width: "100%",
                          background: COLORS.red,
                          color: "white",
                          border: `1px solid ${COLORS.red}`,
                        }}
                        title="Requires admin password. Locks all scoring and finalizes leaderboards."
                      >
                        Finalize Leaderboard (Lock)
                      </button>
                    )}

                  {/* Leaderboard Adjust Tool (ADMIN REQUIRED) */}
                  <button
                    onClick={openAdjustmentsEditor}
                    style={{
                      ...smallButtonStyle,
                      width: "100%",
                      background: "#fff",
                      border: `1px solid ${COLORS.navy}`,
                      color: COLORS.navy,
                    }}
                    disabled={finalized || players.length === 0}
                    title="Requires admin password. Adjust leaderboard totals before finalize."
                  >
                    {adjustOpen
                      ? "Close Leaderboard Edit"
                      : "Edit Leaderboard Scores"}
                  </button>

                  {/* Enable/Disable payouts toggle */}
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
                    disabled={players.length === 0}
                    title="Requires admin password. Turning off clears posted payouts."
                  >
                    Enable Payouts: {payoutsEnabled ? "On" : "Off"}
                  </button>

                  {payoutsEnabled && (
                    <>
                      <button
                        onClick={() =>
                          requireAdmin(async () => {
                            if (
                              !putting.payoutConfig ||
                              typeof putting.payoutConfig !== "object"
                            ) {
                              await updatePutting({
                                payoutConfig: {
                                  ...DEFAULT_PAYOUT_CONFIG,
                                  enabled: true,
                                },
                                payoutsPosted: {},
                              });
                            }
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
                        disabled={players.length === 0}
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
                            marginTop: 0,
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
                              value={
                                poolMode === "combined"
                                  ? "pool"
                                  : payoutConfig?.mode ?? ""
                              }
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
                              disabled={poolMode === "combined"}
                              title={
                                poolMode === "combined"
                                  ? "Combined Pool forces 'By Pool' payouts."
                                  : ""
                              }
                            >
                              <option value="">Select mode…</option>
                              <option value="pool">
                                {poolMode === "combined"
                                  ? "By Pool (All Players)"
                                  : "By Pool"}
                              </option>
                              {poolMode !== "combined" && (
                                <option value="collective">Collective</option>
                              )}
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

                                let modeOk =
                                  payoutConfig?.mode === "pool" ||
                                  payoutConfig?.mode === "collective"
                                    ? payoutConfig.mode
                                    : "";

                                if (poolMode === "combined") modeOk = "pool";

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

                          <div
                            style={{
                              fontSize: 12,
                              opacity: 0.75,
                              textAlign: "left",
                            }}
                          >
                            Tip: This clears previously posted payouts (if any).
                          </div>
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
                            : !payoutsEnabled
                            ? "Enable payouts first."
                            : "Requires admin password."
                        }
                      >
                        Post Payouts to Leaderboard
                      </button>

                      <div style={{ fontSize: 12, opacity: 0.75 }}>
                        Payouts:{" "}
                        <strong>
                          {`$${clampInt(
                            payoutConfig.buyInDollars,
                            0,
                            50
                          )} buy-in • ${clampInt(
                            payoutConfig.leagueFeePct,
                            0,
                            50
                          )}% fee • ${
                            poolMode === "combined"
                              ? "By Pool"
                              : payoutConfig.mode === "pool"
                              ? "By Pool"
                              : "Collective"
                          }`}
                        </strong>
                        {finalized ? (
                          <span style={{ marginLeft: 8 }}>
                            • Posted:{" "}
                            <strong
                              style={{
                                color: hasPostedPayouts
                                  ? COLORS.green
                                  : COLORS.red,
                              }}
                            >
                              {hasPostedPayouts ? "Yes" : "No"}
                            </strong>
                          </span>
                        ) : null}
                      </div>
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
                        style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}
                      >
                        Set a player’s <strong>final leaderboard total</strong>.
                        This creates an adjustment. Disabled after Finalize.
                      </div>

                      <div style={{ display: "grid", gap: 8 }}>
                        {players.map((p) => {
                          const base =
                            playMode === "sequential"
                              ? cumulativeBaseTotalForPlayerSeq(p.id)
                              : cumulativeBaseTotalForPlayerSim(p.id);

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
                                <div
                                  style={{
                                    fontWeight: 900,
                                    color: COLORS.text,
                                  }}
                                >
                                  {p.name}{" "}
                                  <span style={{ fontSize: 12, opacity: 0.7 }}>
                                    {poolMode === "combined"
                                      ? "(Combined)"
                                      : `(${
                                          p.pool === "B"
                                            ? "B"
                                            : p.pool === "C"
                                            ? "C"
                                            : "A"
                                        } Pool)`}
                                  </span>
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
                    onClick={async () => {
                      await requireAdmin(async () => {
                        const ok = window.confirm(
                          "Reset PUTTING league only?\n\nThis clears putting players, cards, scores, settings, leaderboard adjustments, and payout settings.\n(Tag rounds will NOT be affected.)"
                        );
                        if (!ok) return;

                        await updateDoc(leagueRef, {
                          puttingLeague: {
                            settings: {
                              stations: 1,
                              rounds: 1,
                              finalized: false,

                              playMode: "simultaneous",
                              poolMode: "split",

                              locked: false,
                              currentRound: 0,
                              cardMode: "",

                              seqFormatLocked: false,
                              seqCheckInLocked: false,
                            },

                            players: [],
                            adjustments: {},
                            payoutConfig: { ...DEFAULT_PAYOUT_CONFIG },
                            payoutsPosted: {},

                            cardsByRound: {},
                            scores: {},
                            submitted: {},

                            seqCards: [],
                            seqRoundScores: {},
                            seqSubmitted: {},
                            seqPlayerRounds: {},
                          },
                        });

                        setActiveCardId("");
                        setOpenStations({});
                        setSelectedForCard([]);
                        setCardName("");
                        setName("");
                        setPool("A");
                        setSetupOpen(false);
                        setCheckinOpen(true);
                        setCardsOpen(true);
                        setLeaderboardsOpen(false);
                        setAdjustOpen(false);
                        setPayoutsOpen(false);

                        setSeqSelectedForCard([]);
                        setSeqCardName("");
                        setSeqOpenCardIds({});
                      });
                    }}
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
            )}
          </div>

          {/* CHECK-IN (Mode-aware gating; stays present in Sequential) */}
          {(playMode === "simultaneous" ? !roundStartedSim : true) && (
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
                  {playMode === "sequential" && !seqFormatLocked ? (
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                      Check-in is closed until the admin clicks{" "}
                      <strong>Lock Format and Open Check-In</strong>.
                    </div>
                  ) : null}

                  {playMode === "sequential" && seqCheckInLocked ? (
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                      Check-in is <strong>locked</strong>. No new players can be
                      added.
                    </div>
                  ) : null}

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      flexWrap: "wrap",
                      alignItems: "center",
                      marginTop: 10,
                    }}
                  >
                    <input
                      placeholder="Player name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      style={{ ...inputStyle, width: 240 }}
                      disabled={
                        finalized ||
                        (playMode === "simultaneous"
                          ? false
                          : !seqFormatLocked || seqCheckInLocked)
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
                          (playMode === "simultaneous"
                            ? false
                            : !seqFormatLocked || seqCheckInLocked)
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
                        (playMode === "sequential" &&
                          (!seqFormatLocked || seqCheckInLocked))
                      }
                    >
                      Add
                    </button>
                  </div>

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
                              fontSize: 12,
                              fontWeight: 900,
                              color: COLORS.navy,
                            }}
                          >
                            {poolMode === "combined"
                              ? "Combined"
                              : p.pool === "B"
                              ? "B Pool"
                              : p.pool === "C"
                              ? "C Pool"
                              : "A Pool"}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                      Add players as they arrive.
                    </div>
                  )}

                  {/* SIMULTANEOUS: card mode buttons */}
                  {showCardModeButtons && (
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
                          Manually Create Cards
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

                  {/* SEQUENTIAL: quick card formation lives here */}
                  {playMode === "sequential" && seqFormatLocked && (
                    <div
                      style={{
                        marginTop: 12,
                        border: `1px solid ${COLORS.border}`,
                        borderRadius: 12,
                        background: "#fff",
                        padding: 10,
                      }}
                    >
                      <div style={{ fontWeight: 900, color: COLORS.navy }}>
                        Form a Card (Sequential Mode)
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
                        Select 2–4 unassigned players, then create a card.
                      </div>

                      <div
                        style={{
                          marginTop: 10,
                          display: "flex",
                          gap: 10,
                          flexWrap: "wrap",
                          alignItems: "center",
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
                          Selected: <strong>{seqSelectedForCard.length}</strong>{" "}
                          / 4
                        </div>
                      </div>

                      <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                        {(() => {
                          const assigned = new Set();
                          seqCards.forEach((c) =>
                            (c.playerIds || []).forEach((id) =>
                              assigned.add(id)
                            )
                          );

                          const available = players.filter(
                            (p) => !assigned.has(p.id)
                          );

                          if (!available.length) {
                            return (
                              <div style={{ fontSize: 12, opacity: 0.75 }}>
                                No unassigned players available.
                              </div>
                            );
                          }

                          return available.map((p) => {
                            const isSelected = seqSelectedForCard.includes(
                              p.id
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
                                    onChange={() => toggleSeqSelect(p.id)}
                                  />
                                  <div style={{ fontWeight: 900 }}>
                                    {p.name}
                                  </div>
                                </div>

                                <div
                                  style={{
                                    fontSize: 12,
                                    fontWeight: 900,
                                    color: COLORS.navy,
                                  }}
                                >
                                  {poolMode === "combined"
                                    ? "Combined"
                                    : p.pool === "B"
                                    ? "B Pool"
                                    : p.pool === "C"
                                    ? "C Pool"
                                    : "A Pool"}
                                </div>
                              </label>
                            );
                          });
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* CARDS (Mode-aware) */}
          {playMode === "simultaneous" ? (
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
                  Cards — Round {currentRound || 1}
                </div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  {cardsOpen ? "Tap to collapse" : "Tap to expand"}
                </div>
              </div>

              {cardsOpen && (
                <div style={{ marginTop: 10 }}>
                  {!roundStartedSim && cardMode === "manual" ? (
                    <>
                      <div
                        style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}
                      >
                        Create Round 1 cards (2–4 players). Pools can be mixed.
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
                            onClick={createCardSim}
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
                            Selected: <strong>{selectedForCard.length}</strong>{" "}
                            / 4<span style={{ marginLeft: 8 }}>(min 2)</span>
                          </div>
                        </div>

                        <div style={{ display: "grid", gap: 8 }}>
                          {players.map((p) => {
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
                                  background: already ? "#fafafa" : COLORS.soft,
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
                                <div
                                  style={{
                                    fontSize: 12,
                                    fontWeight: 900,
                                    color: COLORS.navy,
                                  }}
                                >
                                  {poolMode === "combined"
                                    ? "Combined"
                                    : p.pool === "B"
                                    ? "B Pool"
                                    : p.pool === "C"
                                    ? "C Pool"
                                    : "A Pool"}
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  ) : roundStartedSim && currentRound >= 2 ? (
                    <div
                      style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}
                    >
                      Cards for Round {currentRound} are auto-created based on
                      Round {currentRound - 1} totals.
                    </div>
                  ) : !roundStartedSim ? (
                    <div
                      style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}
                    >
                      Choose Manual or Random cards above. Round 1 requires all
                      players be assigned to cards before starting.
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
                          {roundStartedSim && currentRound ? (
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
                            const p = playerById[pid];
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
                                <span
                                  style={{
                                    fontSize: 12,
                                    fontWeight: 900,
                                    color: COLORS.navy,
                                  }}
                                >
                                  {poolMode === "combined"
                                    ? "Combined"
                                    : p.pool === "B"
                                    ? "B Pool"
                                    : p.pool === "C"
                                    ? "C Pool"
                                    : "A Pool"}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            // SEQUENTIAL: cards formed + per-round submission UI
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
                onClick={() => setSeqCardsOpen((v) => !v)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  cursor: "pointer",
                  gap: 10,
                }}
              >
                <div style={{ fontWeight: 900, color: COLORS.navy }}>
                  Cards Formed ({seqCards.length})
                </div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  {seqCardsOpen ? "Tap to collapse" : "Tap to expand"}
                </div>
              </div>

              {seqCardsOpen && (
                <div style={{ marginTop: 10 }}>
                  {!seqCards.length ? (
                    <div style={{ fontSize: 12, opacity: 0.75 }}>
                      No cards yet. Use the Check-In section to form cards.
                    </div>
                  ) : (
                    <div style={{ display: "grid", gap: 10 }}>
                      {seqCards.map((c) => {
                        const open = !!seqOpenCardIds[c.id];
                        const next = nextRoundForCard(c.id);
                        const done = next === null;

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
                                setSeqOpenCardIds((prev) => ({
                                  ...prev,
                                  [c.id]: !prev[c.id],
                                }))
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
                              <div
                                style={{ fontWeight: 900, color: COLORS.navy }}
                              >
                                {c.name}
                              </div>
                              <div style={{ fontSize: 12, opacity: 0.75 }}>
                                {open ? "Tap to collapse" : "Tap to expand"}
                              </div>
                            </div>

                            {open && (
                              <div style={{ padding: 12 }}>
                                <div
                                  style={{
                                    fontSize: 12,
                                    opacity: 0.75,
                                    marginBottom: 10,
                                  }}
                                >
                                  Players
                                </div>

                                <div style={{ display: "grid", gap: 8 }}>
                                  {(c.playerIds || []).map((pid) => {
                                    const p = playerById[pid];
                                    if (!p) return null;
                                    return (
                                      <div
                                        key={pid}
                                        style={{
                                          padding: "10px 12px",
                                          borderRadius: 12,
                                          border: `1px solid ${COLORS.border}`,
                                          background: COLORS.soft,
                                          display: "flex",
                                          justifyContent: "space-between",
                                          alignItems: "center",
                                        }}
                                      >
                                        <div style={{ fontWeight: 900 }}>
                                          {p.name}
                                        </div>
                                        <div
                                          style={{
                                            fontSize: 12,
                                            fontWeight: 900,
                                            color: COLORS.navy,
                                          }}
                                        >
                                          {poolMode === "combined"
                                            ? "Combined"
                                            : p.pool === "B"
                                            ? "B"
                                            : p.pool === "C"
                                            ? "C"
                                            : "A"}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>

                                <div style={{ marginTop: 14 }}>
                                  <div
                                    style={{
                                      fontWeight: 900,
                                      color: COLORS.navy,
                                    }}
                                  >
                                    {done
                                      ? "All rounds submitted ✅"
                                      : `Enter scores for Round ${next}`}
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 12,
                                      opacity: 0.75,
                                      marginTop: 6,
                                    }}
                                  >
                                    Enter each player’s total for the round
                                    (0–50).
                                  </div>

                                  {!done && (
                                    <div
                                      style={{
                                        marginTop: 10,
                                        display: "grid",
                                        gap: 8,
                                      }}
                                    >
                                      {(c.playerIds || []).map((pid) => {
                                        const p = playerById[pid];
                                        if (!p) return null;
                                        const v = seqScoreValue(next, pid);
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
                                            <div
                                              style={{
                                                fontWeight: 900,
                                                minWidth: 0,
                                              }}
                                            >
                                              {p.name}
                                            </div>

                                            <select
                                              value={v === "" ? "" : String(v)}
                                              onChange={(e) =>
                                                setSeqRoundScore(
                                                  next,
                                                  pid,
                                                  e.target.value === ""
                                                    ? ""
                                                    : Number(e.target.value)
                                                )
                                              }
                                              disabled={finalized}
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
                                  )}

                                  <div style={{ marginTop: 12 }}>
                                    <button
                                      onClick={() => submitSeqCardRound(c.id)}
                                      disabled={finalized || done}
                                      style={{
                                        ...buttonStyle,
                                        width: "100%",
                                        background: done
                                          ? "#ddd"
                                          : COLORS.green,
                                        color: done ? "#444" : "white",
                                        border: `1px solid ${
                                          done ? "#ddd" : COLORS.green
                                        }`,
                                      }}
                                    >
                                      {done
                                        ? "Card Complete"
                                        : next === totalRounds
                                        ? "Submit Final Round Scores"
                                        : `Submit Round ${next} Scores`}
                                    </button>

                                    <div
                                      style={{
                                        marginTop: 8,
                                        fontSize: 12,
                                        opacity: 0.75,
                                        textAlign: "center",
                                      }}
                                    >
                                      Submission requires admin password and
                                      updates the leaderboard.
                                    </div>
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
              )}
            </div>
          )}

          {/* SCOREKEEPER (SIMULTANEOUS ONLY) */}
          {playMode === "simultaneous" && roundStartedSim ? (
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
                    .map((pid) => playerById[pid])
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
                                                color: COLORS.text,
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                              }}
                                            >
                                              {row.name}{" "}
                                              <span
                                                style={{
                                                  fontSize: 12,
                                                  opacity: 0.75,
                                                }}
                                              >
                                                (
                                                {poolMode === "combined"
                                                  ? "ALL"
                                                  : row.pool === "B"
                                                  ? "B"
                                                  : row.pool === "C"
                                                  ? "C"
                                                  : "A"}
                                                )
                                              </span>
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
                            const total = roundTotalForPlayerSim(
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
                  : "(Cumulative)"}
                {" — "}
                {poolMode === "combined" ? "Combined Pool" : "Split Pool"}
              </span>
              <span style={{ fontSize: 12, opacity: 0.75 }}>
                {leaderboardsOpen ? "Tap to hide" : "Tap to show"}
              </span>
            </div>

            {leaderboardsOpen && (
              <div style={{ display: "grid", gap: 10 }}>
                {(poolMode === "combined" ? ["ALL"] : ["A", "B", "C"]).map(
                  (k) => {
                    const label =
                      k === "ALL"
                        ? "All Players"
                        : k === "A"
                        ? "A Pool"
                        : k === "B"
                        ? "B Pool"
                        : "C Pool";

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

                                          {playMode === "sequential" ? (
                                            <span
                                              style={{
                                                fontSize: 12,
                                                opacity: 0.75,
                                                marginLeft: 8,
                                              }}
                                            >
                                              — through R{r.throughRound || 0}
                                            </span>
                                          ) : null}

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
                  }
                )}
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
            {playMode === "simultaneous"
              ? "Tip: Round 1 cards must be created before starting. After that, cards are auto-created each round based on the previous round’s totals."
              : "Sequential workflow: Admin locks format → check-in stays open while cards play → cards submit round scores → admin locks check-in → finalize leaderboard."}
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
