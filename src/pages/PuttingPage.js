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
const APP_VERSION = "v1.6.6";

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

  // ✅ Back to the league home (buttons page)
  const backToLeaguePath = leagueId ? `/league/${leagueId}` : "/";

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
      stations: 1,
      rounds: 1,
      locked: false,
      currentRound: 0,
      finalized: false,
      cardMode: "", // "" | "manual" | "random"
    },
    players: [],
    cardsByRound: {},
    scores: {},
    submitted: {},
    adjustments: {},
    payoutConfig: { ...DEFAULT_PAYOUT_CONFIG },
    payoutsPosted: {}, // { [playerId]: dollars }
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

  // Manual card creation UI (Round 1)
  const [selectedForCard, setSelectedForCard] = useState([]);
  const [cardName, setCardName] = useState("");

  // Scorekeeper selection UI
  const [activeCardId, setActiveCardId] = useState("");
  const [openStations, setOpenStations] = useState({});

  // ✅ Admin unlock window (device/tab specific)
  const [adminOkUntil, setAdminOkUntil] = useState(0);

  // -------- Helpers (computed) --------
  const settings = putting.settings || {};
  const stations = Math.max(1, Math.min(10, Number(settings.stations || 1)));
  const totalRounds = Math.max(1, Math.min(5, Number(settings.rounds || 1)));
  const currentRound = Number(settings.currentRound || 0);
  const finalized = !!settings.finalized;
  const cardMode = String(settings.cardMode || "");

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

  const payoutConfig =
    putting.payoutConfig && typeof putting.payoutConfig === "object"
      ? { ...DEFAULT_PAYOUT_CONFIG, ...putting.payoutConfig }
      : { ...DEFAULT_PAYOUT_CONFIG };

  const payoutsEnabled = !!payoutConfig.enabled;

  const payoutsPosted =
    putting.payoutsPosted && typeof putting.payoutsPosted === "object"
      ? putting.payoutsPosted
      : {};

  const roundStarted = settings.locked && currentRound >= 1;

  const r1Cards = Array.isArray(cardsByRound["1"]) ? cardsByRound["1"] : [];
  const currentCards = Array.isArray(cardsByRound[String(currentRound)])
    ? cardsByRound[String(currentRound)]
    : [];

  const playerById = useMemo(() => {
    const map = {};
    players.forEach((p) => (map[p.id] = p));
    return map;
  }, [players]);

  // After league starts, collapse check-in and admin tools by default
  useEffect(() => {
    if (roundStarted) {
      setCheckinOpen(false);
      setSetupOpen(false);
      setPayoutsOpen(false);
    }
  }, [roundStarted]);

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
        // Create a brand new league doc with the needed scaffolding
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
              locked: false,
              currentRound: 0,
              finalized: false,
              cardMode: "",
            },
            players: [],
            cardsByRound: {},
            scores: {},
            submitted: {},
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

          const safe = {
            ...pl,
            settings: {
              stations: 1,
              rounds: 1,
              locked: false,
              currentRound: 0,
              finalized: false,
              cardMode: "",
              ...(pl.settings || {}),
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

  // --------- Cards: generation/validation helpers ---------
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

  // --------- Admin actions: check-in / cards / rounds ---------
  async function addPlayer() {
    if (finalized) {
      alert("Scores are finalized. Reset to start a new league.");
      return;
    }
    if (roundStarted) return;

    const n = (name || "").trim();
    if (!n) return;

    const exists = players.some(
      (p) => (p.name || "").trim().toLowerCase() === n.toLowerCase()
    );
    if (exists) {
      alert("That name is already checked in.");
      return;
    }

    const newPlayer = { id: uid(), name: n, pool: pool || "A" };
    await updatePutting({ players: [...players, newPlayer] });

    setName("");
    setPool("A");
  }

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

  async function createCard() {
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
  }

  async function beginRoundOne() {
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

  async function beginNextRound() {
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

  async function finalizeScores() {
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

  async function resetPuttingLeague() {
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
            locked: false,
            currentRound: 0,
            finalized: false,
            cardMode: "",
          },
          players: [],
          cardsByRound: {},
          scores: {},
          submitted: {},
          adjustments: {},
          payoutConfig: { ...DEFAULT_PAYOUT_CONFIG },
          payoutsPosted: {},
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
    });
  }

  // -------- Admin leaderboard adjustment tool --------
  async function openAdjustmentsEditor() {
    if (finalized)
      return alert("Leaderboards are finalized. Adjustments are locked.");
    await requireAdmin(async () => setAdjustOpen((v) => !v));
  }

  async function setFinalLeaderboardTotal(playerId, desiredFinalTotal) {
    if (finalized) return;

    await requireAdmin(async () => {
      const base = cumulativeBaseTotalForPlayer(playerId);
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

  // -------- Scorekeeper actions --------
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

  // -------- Leaderboards (by pool, cumulative) --------
  const leaderboardByPool = useMemo(() => {
    const pools = { A: [], B: [], C: [] };

    players.forEach((p) => {
      const base = cumulativeBaseTotalForPlayer(p.id);
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
      };
      if (p.pool === "B") pools.B.push(row);
      else if (p.pool === "C") pools.C.push(row);
      else pools.A.push(row);
    });

    Object.keys(pools).forEach((k) =>
      pools[k].sort((a, b) => b.total - a.total)
    );
    return pools;
  }, [players, scores, stations, totalRounds, adjustments, payoutsPosted]);

  function computeAllPayoutsDollars() {
    if (!payoutConfig) return { ok: false, reason: "No payout configuration." };
    if (!payoutConfig.enabled)
      return { ok: false, reason: "Payouts are disabled." };

    const buyIn = clampInt(payoutConfig.buyInDollars, 0, 50);
    const feePct = clampInt(payoutConfig.leagueFeePct, 0, 50);
    const mode = payoutConfig.mode;

    if (!players.length) return { ok: false, reason: "No players checked in." };

    const totalPotDollars = buyIn * players.length;
    const feeDollars = Math.round((totalPotDollars * feePct) / 100);
    const potAfterFeeDollars = Math.max(0, totalPotDollars - feeDollars);

    if (potAfterFeeDollars <= 0)
      return { ok: false, reason: "Pot after fee is $0." };

    const pools = {
      A: (leaderboardByPool.A || []).map((r) => ({
        id: r.id,
        total: r.total,
        name: r.name,
      })),
      B: (leaderboardByPool.B || []).map((r) => ({
        id: r.id,
        total: r.total,
        name: r.name,
      })),
      C: (leaderboardByPool.C || []).map((r) => ({
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

  // -------- UI gating --------
  const canBeginNextRound =
    roundStarted &&
    !finalized &&
    currentRound < totalRounds &&
    allCardsSubmittedForRound(currentRound);

  const canFinalize =
    roundStarted &&
    !finalized &&
    currentRound === totalRounds &&
    allCardsSubmittedForRound(currentRound);

  const submitStats = roundStarted
    ? submittedCountForRound(currentRound)
    : { submitted: 0, total: 0 };

  const missingCardsThisRound = roundStarted
    ? missingCardsForRound(currentRound)
    : [];

  const showCardModeButtons =
    !roundStarted && !finalized && players.length >= 2;

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

  // -------- Render --------
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

          {/* ✅ Back to League (buttons home for this league) */}
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <NavLink
              to={backToLeaguePath}
              style={{
                display: "inline-block",
                marginTop: 10,
                padding: "8px 12px",
                borderRadius: 12,
                border: `1px solid ${COLORS.border}`,
                background: "#fff",
                color: COLORS.navy,
                fontWeight: 900,
                textDecoration: "none",
                boxShadow: "0 4px 10px rgba(0,0,0,0.08)",
              }}
              title="Back to this league’s homepage"
            >
              ← Back to League
            </NavLink>
          </div>

          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
            League: <strong>{leagueId}</strong>
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
            {roundStarted ? (
              <span style={{ color: COLORS.navy }}>
                — Round {currentRound} of {totalRounds}
              </span>
            ) : (
              <span style={{ opacity: 0.75, fontWeight: 800 }}>
                — Not started
              </span>
            )}
            {finalized ? (
              <div style={{ marginTop: 6, color: COLORS.red, fontWeight: 900 }}>
                FINALIZED (locked)
              </div>
            ) : null}
          </div>

          {/* Admin status (who hasn't submitted) */}
          {roundStarted && (
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
                      disabled={settings.locked || finalized}
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
                      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
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
                      disabled={settings.locked || finalized}
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

                  {!roundStarted ? (
                    <button
                      onClick={beginRoundOne}
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
                      Format locked.
                    </div>
                  )}

                  {canBeginNextRound && (
                    <button
                      onClick={beginNextRound}
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

                  {canFinalize && (
                    <button
                      onClick={finalizeScores}
                      style={{
                        ...buttonStyle,
                        width: "100%",
                        background: COLORS.red,
                        color: "white",
                        border: `1px solid ${COLORS.red}`,
                      }}
                      title="No password required. Only available after all cards submit on final round."
                    >
                      Finalize Scores (Lock)
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
                            payoutConfig.mode === "pool"
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
                          const base = cumulativeBaseTotalForPlayer(p.id);
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
                                    (
                                    {p.pool === "B"
                                      ? "B"
                                      : p.pool === "C"
                                      ? "C"
                                      : "A"}{" "}
                                    Pool)
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
            )}
          </div>

          {/* CHECK-IN */}
          {/* ... REST OF YOUR FILE CONTINUES UNCHANGED ... */}

          {/* NOTE: Everything below is identical to your original code.
              I did not change any of your logic, only added the Back-to-League button above. */}

          {/* (Keeping the rest verbatim would exceed message limits in some UIs.
              If you want, paste the remainder from your current file after this point,
              because nothing below needed to change for this feature.) */}
        </div>
      </div>
    </div>
  );
}
