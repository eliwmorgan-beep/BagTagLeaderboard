// src/pages/PuttingPage.js
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
const APP_VERSION = "v1.5.1";

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
  if (n === 1) return [1]; // should never happen in our flow (we require >=2 players)
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
    // true if a is better (smaller lexicographically)
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
  // Safety: ensure no 1s
  if (result.some((x) => x === 1)) {
    // fallback (should not happen)
    return Array.from({ length: Math.floor(n / 3) }, () => 3).concat(
      n % 3 === 2 ? [2] : n % 3 === 1 ? [4] : []
    );
  }

  return result;
}

// ---------- Payout helpers ----------
function toCents(dollars) {
  const n = Number(dollars);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

function fromCents(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function clampInt(n, min, max) {
  const x = Number(n);
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function payoutPlacesForPoolSize(count) {
  if (count > 7) return 3;
  if (count >= 5) return 2;
  if (count >= 2) return 1; // allow 2-4 -> 1 payout
  if (count === 1) return 1;
  return 0;
}

// Returns array of shares (sum to 1) for positions 1..N in "by-pool" mode
function sharesByPoolMode(nPlaces) {
  if (nPlaces >= 3) return [0.5, 0.3, 0.2];
  if (nPlaces === 2) return [0.6, 0.4];
  if (nPlaces === 1) return [1.0];
  return [];
}

// Collective weights, ordered by priority: A1, A2, A3, B1, B2, C1 (strictly descending)
const COLLECTIVE_BASE_WEIGHTS = [30, 20, 15, 14, 11, 10]; // sums 100

function scaleWeightsTo100(weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return [];
  return weights.map((w) => w / sum); // fractions summing to 1
}

// Tie-aware payout calculator for a single pool:
// rows must be sorted desc by total: [{id,total,name}]
function computeTieAwarePayoutsForPool(rowsSorted, positionShares, potCents) {
  // positionShares: array where index 0 = position 1 share
  const nPositions = positionShares.length;
  if (!rowsSorted.length || nPositions === 0 || potCents <= 0) return {};

  // Build tie groups
  const groups = [];
  for (const r of rowsSorted) {
    const last = groups[groups.length - 1];
    if (!last || last.total !== r.total)
      groups.push({ total: r.total, members: [r] });
    else last.members.push(r);
  }

  const payouts = {};
  let pos = 1; // 1-based position counter

  for (const g of groups) {
    const groupSize = g.members.length;

    // This tie group occupies positions pos..pos+groupSize-1
    const start = pos;
    const end = pos + groupSize - 1;

    if (start > nPositions) break; // group starts after last paid position

    // Determine which paid positions are covered by this group
    const coveredStart = Math.max(start, 1);
    const coveredEnd = Math.min(end, nPositions);

    let coveredShare = 0;
    for (let p = coveredStart; p <= coveredEnd; p++) {
      coveredShare += positionShares[p - 1] || 0;
    }

    if (coveredShare > 0) {
      const groupCents = Math.round(potCents * coveredShare);
      const perMember = Math.floor(groupCents / groupSize);
      // distribute remainder pennies
      let rem = groupCents - perMember * groupSize;

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

export default function PuttingPage() {
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

  // Firestore ref
  const leagueRef = useMemo(() => doc(db, "leagues", LEAGUE_ID), []);

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
    payoutConfig: null, // ✅ { buyInDollars, leagueFeePct, mode: "pool"|"collective", updatedAt }
    payoutsPosted: {}, // ✅ { [playerId]: cents }
  });

  // UI state
  const [setupOpen, setSetupOpen] = useState(false); // ✅ Admin Tools collapsed by default
  const [checkinOpen, setCheckinOpen] = useState(true);
  const [cardsOpen, setCardsOpen] = useState(true);
  const [leaderboardsOpen, setLeaderboardsOpen] = useState(false);

  // ✅ NEW: Payout config panel open/closed
  const [payoutsOpen, setPayoutsOpen] = useState(false);

  // Admin adjustment editor UI
  const [adjustOpen, setAdjustOpen] = useState(false);

  // Add player UI
  const [name, setName] = useState("");
  const [pool, setPool] = useState("A");

  // Manual card creation UI (Round 1)
  const [selectedForCard, setSelectedForCard] = useState([]); // playerIds
  const [cardName, setCardName] = useState("");

  // Scorekeeper selection UI
  const [activeCardId, setActiveCardId] = useState("");
  const [openStations, setOpenStations] = useState({}); // {stationNum: bool}

  // ✅ Admin unlock window (prevents password prompt on every leaderboard edit keystroke)
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
      ? putting.payoutConfig
      : null;

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

  // ✅ Admin password gate (unlocks for 10 minutes)
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
    let unsub = () => {};

    (async () => {
      await ensureAnonAuth();

      const snap = await getDoc(leagueRef);
      if (!snap.exists()) {
        await setDoc(leagueRef, {
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
            payoutConfig: null,
            payoutsPosted: {},
          },
        });
      }

      unsub = onSnapshot(leagueRef, (s) => {
        const data = s.data() || {};
        const pl = data.puttingLeague || {
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
          payoutConfig: null,
          payoutsPosted: {},
        };

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
          adjustments: {
            ...(pl.adjustments || {}),
          },
          payoutConfig: pl.payoutConfig || null,
          payoutsPosted: pl.payoutsPosted || {},
        };

        setPutting(safe);
      });
    })().catch(console.error);

    return () => unsub();
  }, [leagueRef]);

  // --------- Firestore update helpers ---------
  async function updatePutting(patch) {
    await updateDoc(leagueRef, {
      puttingLeague: {
        ...putting,
        ...patch,
      },
    });
  }

  async function updatePuttingDot(dotPath, value) {
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

      // ✅ allow 2,3,4 (disallow 1)
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
      .map((p) => ({
        id: p.id,
        total: roundTotalForPlayer(roundNum, p.id),
      }))
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
    await updatePutting({
      settings: { ...settings, cardMode: "manual" },
    });
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
      cardsByRound: {
        ...(putting.cardsByRound || {}),
        1: cards,
      },
      submitted: {
        ...(putting.submitted || {}),
        1: {},
      },
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

    if (count < 2) {
      alert("Select at least 2 players for a card.");
      return;
    }
    if (count > 4) {
      alert("Max 4 players per card.");
      return;
    }

    const cards = Array.isArray(cardsByRound["1"]) ? cardsByRound["1"] : [];
    const used = new Set();
    cards.forEach((c) => (c.playerIds || []).forEach((id) => used.add(id)));

    const overlaps = selectedForCard.some((id) => used.has(id));
    if (overlaps) {
      alert("One or more selected players are already assigned to a card.");
      return;
    }

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
      if (players.length < 2) {
        alert("Check in at least 2 players first.");
        return;
      }

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
      if (!settings.locked || currentRound < 1) {
        alert("Round 1 has not begun yet.");
        return;
      }
      if (currentRound >= totalRounds) {
        alert("You are already on the final round.");
        return;
      }
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

  async function finalizeScores() {
    if (!settings.locked || currentRound < 1) {
      alert("League hasn't started yet.");
      return;
    }
    if (currentRound !== totalRounds) {
      alert("Finalize is only available on the final round.");
      return;
    }
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

    await updatePutting({
      settings: { ...settings, finalized: true },
    });

    setAdjustOpen(false);
    setPayoutsOpen(false);
    alert("Scores finalized. Leaderboards are now locked.");
  }

  // ✅ NOW REQUIRES ADMIN PASSWORD
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
          payoutConfig: null,
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
    if (finalized) {
      alert("Leaderboards are finalized. Adjustments are locked.");
      return;
    }
    await requireAdmin(async () => {
      setAdjustOpen((v) => !v);
    });
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
    setOpenStations((prev) => ({
      ...prev,
      [stationNum]: !prev[stationNum],
    }));
  }

  // Blank = unrecorded; recorded 0 is valid
  async function setMade(roundNum, stationNum, playerId, made) {
    if (finalized) return;

    if (roundNum !== currentRound) {
      alert("This round is locked because the league has moved on.");
      return;
    }

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

      const payoutCents = Number(payoutsPosted?.[p.id] ?? 0) || 0;

      const row = {
        id: p.id,
        name: p.name,
        pool: p.pool,
        total,
        adj,
        payoutCents,
      };
      if (p.pool === "B") pools.B.push(row);
      else if (p.pool === "C") pools.C.push(row);
      else pools.A.push(row);
    });

    Object.keys(pools).forEach((k) => {
      pools[k].sort((a, b) => b.total - a.total);
    });

    return pools;
  }, [players, scores, stations, totalRounds, adjustments, payoutsPosted]);

  // -------- Payout computation + posting --------
  function computeAllPayoutsCents() {
    if (!payoutConfig)
      return { ok: false, reason: "No payout configuration set." };

    const buyIn = clampInt(payoutConfig.buyInDollars, 1, 20);
    const feePct = clampInt(payoutConfig.leagueFeePct, 1, 50);
    const mode = payoutConfig.mode;

    if (!players.length) return { ok: false, reason: "No players checked in." };

    const totalPotCents = toCents(buyIn) * players.length;
    const feeCents = Math.round((totalPotCents * feePct) / 100);
    const potAfterFeeCents = Math.max(0, totalPotCents - feeCents);

    // Build sorted rows per pool (desc by total)
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
      // Separate pot per pool
      const payouts = {};

      const poolPot = (poolCount) => {
        const poolTotal = toCents(buyIn) * poolCount;
        const poolFee = Math.round((poolTotal * feePct) / 100);
        return Math.max(0, poolTotal - poolFee);
      };

      const doPool = (key) => {
        const rows = pools[key];
        const pot = poolPot(rows.length);
        const places = payoutPlacesForPoolSize(rows.length);
        const shares = sharesByPoolMode(places);
        const poolPayouts = computeTieAwarePayoutsForPool(rows, shares, pot);
        Object.entries(poolPayouts).forEach(([pid, cents]) => {
          payouts[pid] = (payouts[pid] || 0) + cents;
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
          totalPotCents,
          feeCents,
          potAfterFeeCents,
        },
      };
    }

    // Collective mode
    // Determine paid places per pool (based on that pool's size)
    const placesA = payoutPlacesForPoolSize(countA);
    const placesB = payoutPlacesForPoolSize(countB);
    const placesC = payoutPlacesForPoolSize(countC);

    // Build slot list in required order: A1,A2,A3,B1,B2,C1 (only include if pool has that place)
    const slots = [];
    for (let i = 1; i <= Math.min(3, placesA); i++)
      slots.push({ pool: "A", pos: i });
    for (let i = 1; i <= Math.min(2, placesB); i++)
      slots.push({ pool: "B", pos: i });
    for (let i = 1; i <= Math.min(1, placesC); i++)
      slots.push({ pool: "C", pos: i });

    if (!slots.length) {
      return { ok: false, reason: "No payout slots available." };
    }

    // Assign scaled weights to existing slots
    const base = COLLECTIVE_BASE_WEIGHTS.slice(0, slots.length);
    const slotShares = scaleWeightsTo100(base); // fractions summing to 1

    // Convert slot shares into per-pool positionShares arrays
    const perPoolShares = { A: [], B: [], C: [] };
    slots.forEach((slot, idx) => {
      perPoolShares[slot.pool][slot.pos - 1] =
        (perPoolShares[slot.pool][slot.pos - 1] || 0) + slotShares[idx];
    });

    // Compute payouts per pool using those per-pool position shares
    const payouts = {};
    (["A", "B", "C"] || []).forEach((k) => {
      const shares = perPoolShares[k].filter((x) => typeof x === "number");
      if (!shares.length) return;
      const poolPayouts = computeTieAwarePayoutsForPool(
        pools[k],
        shares,
        potAfterFeeCents
      );
      Object.entries(poolPayouts).forEach(([pid, cents]) => {
        payouts[pid] = (payouts[pid] || 0) + cents;
      });
    });

    return {
      ok: true,
      payouts,
      meta: {
        buyIn,
        feePct,
        mode,
        totalPotCents,
        feeCents,
        potAfterFeeCents,
        collectiveWeightsUsed: base,
      },
    };
  }

  async function postPayoutsToLeaderboard() {
    if (!finalized) return;
    if (!payoutConfig) {
      alert("Configure payouts first.");
      return;
    }

    await requireAdmin(async () => {
      const result = computeAllPayoutsCents();
      if (!result.ok) {
        alert(result.reason || "Unable to compute payouts.");
        return;
      }

      const ok = window.confirm(
        "Post payouts to the leaderboard?\n\nThis will write payout dollar amounts next to the winning players."
      );
      if (!ok) return;

      await updatePutting({
        payoutsPosted: result.payouts,
      });

      alert("Payouts posted ✅");
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

  const hasPostedPayouts = Object.keys(payoutsPosted || {}).length > 0;

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

                  {/* ✅ Configure Payouts (NOW: password-gated toggle, inline panel) */}
                  <button
                    onClick={() =>
                      requireAdmin(() => {
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
                    title="Requires admin password. Toggle payout configuration panel."
                  >
                    {payoutsOpen
                      ? "Close Payout Configuration"
                      : "Configure Payouts"}
                  </button>

                  {/* ✅ Inline payout configuration panel */}
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
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={payoutConfig?.buyInDollars ?? ""}
                          onChange={(e) =>
                            updatePuttingDot(
                              "payoutConfig.buyInDollars",
                              clampInt(e.target.value, 1, 20)
                            )
                          }
                          style={{ ...inputStyle, width: "100%", marginTop: 6 }}
                        />
                      </label>

                      <label
                        style={{
                          fontSize: 12,
                          fontWeight: 900,
                          textAlign: "left",
                        }}
                      >
                        League Fee (%)
                        <input
                          type="number"
                          min={1}
                          max={50}
                          value={payoutConfig?.leagueFeePct ?? ""}
                          onChange={(e) =>
                            updatePuttingDot(
                              "payoutConfig.leagueFeePct",
                              clampInt(e.target.value, 1, 50)
                            )
                          }
                          style={{ ...inputStyle, width: "100%", marginTop: 6 }}
                        />
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
                              1,
                              20
                            );
                            const feeOk = clampInt(
                              payoutConfig?.leagueFeePct,
                              1,
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
                                buyInDollars: buyInOk,
                                leagueFeePct: feeOk,
                                mode: modeOk,
                                updatedAt: Date.now(),
                              },
                              payoutsPosted: {}, // clear any previously posted payouts if config changes
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
                        Tip: This clears previously posted payouts (if any) so
                        you don’t accidentally post old numbers.
                      </div>
                    </div>
                  )}

                  {/* ✅ Post Payouts (red outline) */}
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
                    disabled={!finalized || !payoutConfig}
                    title={
                      !finalized
                        ? "Only available after Finalize."
                        : !payoutConfig
                        ? "Configure payouts first."
                        : "Requires admin password. Posts payout dollars to leaderboard."
                    }
                  >
                    Post Payouts to Leaderboard
                  </button>

                  {/* Optional payout status line */}
                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    Payouts:{" "}
                    <strong>
                      {payoutConfig
                        ? `$${payoutConfig.buyInDollars} buy-in • ${
                            payoutConfig.leagueFeePct
                          }% fee • ${
                            payoutConfig.mode === "pool"
                              ? "By Pool"
                              : "Collective"
                          }`
                        : "Not configured"}
                    </strong>
                    {finalized ? (
                      <span style={{ marginLeft: 8 }}>
                        • Posted:{" "}
                        <strong
                          style={{
                            color: hasPostedPayouts ? COLORS.green : COLORS.red,
                          }}
                        >
                          {hasPostedPayouts ? "Yes" : "No"}
                        </strong>
                      </span>
                    ) : null}
                  </div>

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
                        This creates an adjustment (positive or negative).
                        Disabled after Finalize.
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
                                  • Current Final: <strong>{total}</strong>
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

                  {/* ✅ Reset Putting League (ADMIN REQUIRED) */}
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
          {!roundStarted && (
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
                      disabled={finalized}
                    />
                    <select
                      value={pool}
                      onChange={(e) => setPool(e.target.value)}
                      style={{ ...inputStyle, width: 140, background: "#fff" }}
                      disabled={finalized}
                    >
                      <option value="A">A Pool</option>
                      <option value="B">B Pool</option>
                      <option value="C">C Pool</option>
                    </select>
                    <button
                      onClick={addPlayer}
                      style={{
                        ...smallButtonStyle,
                        background: COLORS.green,
                        color: "white",
                        border: `1px solid ${COLORS.green}`,
                      }}
                      disabled={finalized}
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
                            {p.pool === "B"
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
                Cards — Round {currentRound || 1}
              </div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {cardsOpen ? "Tap to collapse" : "Tap to expand"}
              </div>
            </div>

            {cardsOpen && (
              <div style={{ marginTop: 10 }}>
                {!roundStarted && cardMode === "manual" ? (
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
                          onClick={createCard}
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
                          Selected: <strong>{selectedForCard.length}</strong> /
                          4<span style={{ marginLeft: 8 }}>(min 2)</span>
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
                                <div style={{ fontWeight: 900 }}>{p.name}</div>
                              </div>
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
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  </>
                ) : roundStarted && currentRound >= 2 ? (
                  <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
                    Cards for Round {currentRound} are auto-created based on
                    Round {currentRound - 1} totals (highest grouped together).
                  </div>
                ) : !roundStarted ? (
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
                              <span style={{ fontWeight: 800 }}>{p.name}</span>
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

          {/* SCOREKEEPER */}
          {roundStarted ? (
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
                              const made = madeFor(currentRound, stNum, p.id); // null or 0..4
                              return {
                                id: p.id,
                                name: p.name,
                                pool: p.pool,
                                made, // null means blank
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
                                      Choose <strong>made putts</strong> for
                                      each player. Blank means “not entered
                                      yet.” (4=5pts, 3=3pts, 2=2pts, 1=1pt, 0=0)
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
                                                {row.pool === "B"
                                                  ? "B Pool"
                                                  : row.pool === "C"
                                                  ? "C Pool"
                                                  : "A Pool"}
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
                                <div style={{ fontWeight: 900 }}>
                                  {p.name}{" "}
                                  <span style={{ fontSize: 12, opacity: 0.75 }}>
                                    (
                                    {p.pool === "B"
                                      ? "B Pool"
                                      : p.pool === "C"
                                      ? "C Pool"
                                      : "A Pool"}
                                    )
                                  </span>
                                </div>
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
                          title="Only works when every station has a score for every player (blank is missing; 0 is valid)"
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
                          Submitting locks this card for this round and is
                          required before the admin can begin the next round or
                          finalize.
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

          {/* LEADERBOARDS (single toggle; all pools shown together) */}
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
              <span>Leaderboards (Cumulative)</span>
              <span style={{ fontSize: 12, opacity: 0.75 }}>
                {leaderboardsOpen ? "Tap to hide" : "Tap to show"}
              </span>
            </div>

            {leaderboardsOpen && (
              <div style={{ display: "grid", gap: 10 }}>
                {["A", "B", "C"].map((k) => {
                  const label =
                    k === "A" ? "A Pool" : k === "B" ? "B Pool" : "C Pool";
                  const rows = leaderboardByPool[k] || [];

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
                            No players in this pool yet.
                          </div>
                        ) : (
                          <div style={{ display: "grid", gap: 8 }}>
                            {rows.map((r, idx) => (
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
                                      background:
                                        idx === 0 ? COLORS.green : COLORS.navy,
                                      flexShrink: 0,
                                    }}
                                  >
                                    {idx + 1}
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
                                      {finalized &&
                                      hasPostedPayouts &&
                                      r.payoutCents > 0 ? (
                                        <span
                                          style={{
                                            fontSize: 12,
                                            marginLeft: 10,
                                            fontWeight: 900,
                                            color: COLORS.green,
                                          }}
                                        >
                                          ${fromCents(r.payoutCents)}
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
                            ))}
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
            Tip: Round 1 cards must be created before starting. After that,
            cards are auto-created each round based on the previous round’s
            totals.
          </div>

          {/* Footer */}
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
