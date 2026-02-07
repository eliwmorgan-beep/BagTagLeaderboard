// src/pages/DoublesPage.js
import React, { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import Header from "../components/Header";
import { db, ensureAnonAuth } from "../firebase";
import { doc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";

const ADMIN_PASSWORD = "Pescado!";
const APP_VERSION = "doubles-per-league-v1.6.0";

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

// ----------------- Payout helpers (Team payouts) -----------------
const DEFAULT_PAYOUT_CONFIG = {
  enabled: true,
  buyInDollars: 5, // per PLAYER buy-in (pot uses total players checked in)
  leagueFeePct: 10,
  updatedAt: null,
};

function clampInt(n, min, max) {
  const x = Number(n);
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function toCents(dollars) {
  const n = Number(dollars);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

function fromCents(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function payoutPlacesForTeamCount(teamCount) {
  if (teamCount > 7) return 3;
  if (teamCount >= 5) return 2;
  if (teamCount >= 2) return 1;
  if (teamCount === 1) return 1;
  return 0;
}

function sharesByPlaces(nPlaces) {
  if (nPlaces >= 3) return [0.5, 0.3, 0.2];
  if (nPlaces === 2) return [0.6, 0.4];
  if (nPlaces === 1) return [1.0];
  return [];
}

/**
 * Whole-dollar allocation by shares:
 * - uses whole dollars only
 * - never exceeds potDollars
 * - sums to potDollars (when potDollars > 0)
 */
function allocateWholeDollarsByShares(positionShares, potCents) {
  const n = positionShares.length;
  if (!n || potCents <= 0) return [];

  const potDollars = Math.floor(potCents / 100);
  if (potDollars <= 0) return new Array(n).fill(0);

  const ideal = positionShares.map((s) => potDollars * (Number(s) || 0));
  const floors = ideal.map((x) => Math.floor(x));
  let used = floors.reduce((a, b) => a + b, 0);

  if (used > potDollars) {
    const fracAsc = ideal
      .map((x, i) => ({ i, frac: x - Math.floor(x) }))
      .sort((a, b) => a.frac - b.frac);

    let over = used - potDollars;
    const out = [...floors];
    for (const f of fracAsc) {
      if (over <= 0) break;
      if (out[f.i] > 0) {
        out[f.i] -= 1;
        over -= 1;
      }
    }
    return out;
  }

  const fracDesc = ideal
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);

  const out = [...floors];
  let remaining = potDollars - used;
  let idx = 0;

  while (remaining > 0 && idx < 100000) {
    const pick = fracDesc[idx % fracDesc.length];
    out[pick.i] += 1;
    remaining -= 1;
    idx += 1;
  }

  const sumOut = out.reduce((a, b) => a + b, 0);
  if (sumOut > potDollars) {
    let over = sumOut - potDollars;
    for (let i = out.length - 1; i >= 0 && over > 0; i--) {
      const take = Math.min(out[i], over);
      out[i] -= take;
      over -= take;
    }
  }

  return out;
}

/**
 * Tie-aware payout distribution for TEAMS:
 * rowsSorted should be sorted by score ASC (lower is better):
 *   [{ teamId, score }]
 * positionShares: for positions 1..N
 * Returns: { [teamId]: cents } (whole-dollar cents)
 *
 * Tie logic: a tie group shares the combined dollars of the positions it spans,
 * split evenly (extra $1 remainders distributed within the group).
 */
function computeTieAwarePayoutsForTeams(rowsSorted, positionShares, potCents) {
  const nPositions = positionShares.length;
  if (!rowsSorted.length || nPositions === 0 || potCents <= 0) return {};

  const posDollars = allocateWholeDollarsByShares(positionShares, potCents);
  const payouts = {};

  // tie groups by identical score
  const groups = [];
  for (const r of rowsSorted) {
    const last = groups[groups.length - 1];
    if (!last || last.score !== r.score)
      groups.push({ score: r.score, members: [r] });
    else last.members.push(r);
  }

  let pos = 1; // 1-based
  for (const g of groups) {
    const groupSize = g.members.length;
    const start = pos;
    const end = pos + groupSize - 1;

    if (start > nPositions) break;

    const coveredStart = Math.max(start, 1);
    const coveredEnd = Math.min(end, nPositions);

    let groupDollars = 0;
    for (let p = coveredStart; p <= coveredEnd; p++) {
      groupDollars += posDollars[p - 1] || 0;
    }

    if (groupDollars > 0) {
      const per = Math.floor(groupDollars / groupSize);
      let rem = groupDollars - per * groupSize;

      g.members.forEach((m) => {
        const add = per + (rem > 0 ? 1 : 0);
        if (rem > 0) rem -= 1;
        payouts[m.teamId] = (payouts[m.teamId] || 0) + add * 100;
      });
    }

    pos += groupSize;
    if (pos > nPositions) break;
  }

  // Safety clamp (should not exceed whole-dollar pot)
  const totalPaidCents = Object.values(payouts).reduce(
    (a, b) => a + (Number(b) || 0),
    0
  );
  const maxCents = Math.floor(potCents / 100) * 100;
  if (totalPaidCents > maxCents) {
    const entries = Object.entries(payouts).sort(
      (a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0)
    );
    let over = totalPaidCents - maxCents;
    for (let i = entries.length - 1; i >= 0 && over > 0; i--) {
      const [tid, cents] = entries[i];
      const take = Math.min(Number(cents) || 0, over);
      payouts[tid] = (Number(cents) || 0) - take;
      over -= take;
    }
  }

  return payouts;
}

/**
 * Tie-aware placements for leaderboard display.
 * rowsSorted must already be sorted by score ASC (lower is better).
 * Competition ranking:
 *  - 1st, then ties share place number, next distinct score shows index+1.
 */
function computeTiePlacesAsc(rowsSorted) {
  const places = {};
  let lastScore = null;
  let lastPlace = 0;

  for (let i = 0; i < rowsSorted.length; i++) {
    const r = rowsSorted[i];
    if (lastScore === null) {
      lastScore = r.score;
      lastPlace = 1;
      places[r.teamId] = 1;
      continue;
    }

    if (r.score === lastScore) {
      places[r.teamId] = lastPlace;
    } else {
      lastScore = r.score;
      lastPlace = i + 1;
      places[r.teamId] = lastPlace;
    }
  }
  return places;
}

function rangeOptions(min, max) {
  const out = [];
  for (let i = min; i <= max; i++) out.push(i);
  return out;
}

// ----------------- Page -----------------
export default function DoublesPage() {
  const { leagueId } = useParams(); // ✅ per-league

  const COLORS = {
    blueLight: "#e6f3ff",
    navy: "#1b1f5a",
    orange: "#f4a83a",
    card: "#ffffff",
    border: "rgba(27,31,90,0.25)",
    muted: "rgba(0,0,0,0.6)",
    green: "#1a7f37",
    red: "#b42318",
    soft: "#f6fbff",
  };

  const leagueRef = useMemo(() => doc(db, "leagues", leagueId), [leagueId]);
  const [loading, setLoading] = useState(true);

  // Doubles state from Firestore
  const [doubles, setDoubles] = useState(null);

  // UI state
  const [todayExpanded, setTodayExpanded] = useState(true);
  const [checkinExpanded, setCheckinExpanded] = useState(true);
  const [adminExpanded, setAdminExpanded] = useState(false);

  // Check-in UI
  const [checkinName, setCheckinName] = useState("");
  const [checkinPool, setCheckinPool] = useState("A");

  // Start round feedback
  const [startRoundMsg, setStartRoundMsg] = useState("");
  const [startRoundMsgColor, setStartRoundMsgColor] = useState(COLORS.muted);

  // Admin settings UI
  const [formatChoice, setFormatChoice] = useState("random"); // "random" | "seated"
  const [caliMode, setCaliMode] = useState("random"); // "random" | "manual"
  const [manualCaliId, setManualCaliId] = useState("");
  const [layoutNote, setLayoutNote] = useState("");

  // Cards UI
  const [expandedCardId, setExpandedCardId] = useState(null);

  // TEAM scoring (not card scoring)
  const [scoreDraftByTeam, setScoreDraftByTeam] = useState({}); // teamId -> score

  // Single submit button per card feedback
  const [submitMsgByCard, setSubmitMsgByCard] = useState({}); // cardId -> string
  const [submitMsgColorByCard, setSubmitMsgColorByCard] = useState({}); // cardId -> color

  // Admin: edit holes
  const [editHolesOpen, setEditHolesOpen] = useState(false);
  const [holeEdits, setHoleEdits] = useState({}); // cardId -> holeNumber

  // Admin: late player
  const [lateName, setLateName] = useState("");
  const [latePool, setLatePool] = useState("A");
  const [lateCardId, setLateCardId] = useState("");
  const [lateMsg, setLateMsg] = useState("");

  // Payout UI (Teams)
  const [payoutsOpen, setPayoutsOpen] = useState(false);

  // Enable payouts toggle (UI state mirrors Firestore)
  const [payoutEnabled, setPayoutEnabled] = useState(
    !!DEFAULT_PAYOUT_CONFIG.enabled
  );
  const [payoutBuyIn, setPayoutBuyIn] = useState(
    DEFAULT_PAYOUT_CONFIG.buyInDollars
  );
  const [payoutFeePct, setPayoutFeePct] = useState(
    DEFAULT_PAYOUT_CONFIG.leagueFeePct
  );

  // ✅ Admin unlock window (device-specific by design; stored only in this browser tab/session)
  const [adminOkUntil, setAdminOkUntil] = useState(0);

  // Ensure baseline shape
  const defaultDoubles = useMemo(
    () => ({
      started: false,
      format: "random", // random | seated
      caliMode: "random", // random | manual
      manualCaliId: "",
      layoutNote: "",
      checkins: [], // [{id,name,pool}]
      cali: { playerId: "", teammateId: "" },
      cards: [], // [{id, startHole, teams:[{id,type:"doubles"|"cali", players:[{id,name,pool}]}]}]
      submissions: {}, // teamId -> {submittedAt, score, label, playersText, teamName, cardId}
      leaderboard: [], // [{teamId, teamName, playersText, score}]
      payoutConfig: { ...DEFAULT_PAYOUT_CONFIG },
      payoutsPosted: {}, // teamId -> cents
      updatedAt: Date.now(),
    }),
    []
  );

  // Admin-only helper: password on click (10 min unlock)
  async function requireAdmin(fn) {
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

  useEffect(() => {
    let unsub = () => {};

    (async () => {
      await ensureAnonAuth();

      unsub = onSnapshot(
        leagueRef,
        async (snap) => {
          // If this league doc doesn't exist yet, create it with a doubles shell.
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

          // backfill payout fields if older docs
          const safe = {
            ...defaultDoubles,
            ...d,
            payoutConfig:
              d.payoutConfig && typeof d.payoutConfig === "object"
                ? { ...DEFAULT_PAYOUT_CONFIG, ...d.payoutConfig }
                : { ...DEFAULT_PAYOUT_CONFIG },
            payoutsPosted:
              d.payoutsPosted && typeof d.payoutsPosted === "object"
                ? d.payoutsPosted
                : {},
          };

          setDoubles(safe);
          setLoading(false);

          // keep admin UI synced
          setFormatChoice(safe.format || "random");
          setCaliMode(safe.caliMode || "random");
          setManualCaliId(safe.manualCaliId || "");
          setLayoutNote(safe.layoutNote || "");

          // sync payout UI fields
          const enabled =
            safe.payoutConfig?.enabled === undefined
              ? !!DEFAULT_PAYOUT_CONFIG.enabled
              : !!safe.payoutConfig.enabled;
          setPayoutEnabled(enabled);

          setPayoutBuyIn(clampInt(safe.payoutConfig?.buyInDollars, 0, 50));
          setPayoutFeePct(clampInt(safe.payoutConfig?.leagueFeePct, 0, 50));

          // default late card selection
          if (!lateCardId && (safe.cards || []).length) {
            setLateCardId(safe.cards[0].id);
          }
        },
        () => setLoading(false)
      );
    })().catch(() => setLoading(false));

    return () => unsub();
  }, [leagueRef, defaultDoubles, lateCardId]);

  const isSeated = (doubles?.format || "random") === "seated";
  const started = !!doubles?.started;

  const checkins = doubles?.checkins || [];
  const cards = doubles?.cards || [];
  const submissions = doubles?.submissions || {};
  const leaderboard = doubles?.leaderboard || [];

  const payoutConfig =
    doubles?.payoutConfig && typeof doubles.payoutConfig === "object"
      ? { ...DEFAULT_PAYOUT_CONFIG, ...doubles.payoutConfig }
      : { ...DEFAULT_PAYOUT_CONFIG };

  const payoutsPosted =
    doubles?.payoutsPosted && typeof doubles.payoutsPosted === "object"
      ? doubles.payoutsPosted
      : {};

  const payoutsAreEnabled = payoutConfig?.enabled !== false; // default true
  const hasPostedPayouts =
    payoutsAreEnabled && Object.keys(payoutsPosted || {}).length > 0;

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

  // Tie-aware places for leaderboard (ASC scoring)
  const tiePlaces = useMemo(() => {
    const rowsSorted = [...leaderboard].sort(
      (a, b) => Number(a.score ?? 0) - Number(b.score ?? 0)
    );
    return computeTiePlacesAsc(
      rowsSorted.map((r) => ({ teamId: r.teamId, score: Number(r.score ?? 0) }))
    );
  }, [leaderboard]);

  async function saveAdminSettings() {
    await requireAdmin(async () => {
      await updateDoc(leagueRef, {
        "doubles.format": formatChoice,
        "doubles.caliMode": caliMode,
        "doubles.manualCaliId": caliMode === "manual" ? manualCaliId : "",
        "doubles.layoutNote": layoutNote || "",
        "doubles.updatedAt": Date.now(),
      });
      alert("Saved format/settings.");
    });
  }

  async function addCheckin() {
    const name = checkinName.trim();
    if (!name) return;

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
    if (checkinsList.length % 2 === 0)
      return { caliId: "", remaining: [...checkinsList] };

    if (fmt === "seated") {
      const A = checkinsList.filter((p) => p.pool === "A");
      const B = checkinsList.filter((p) => p.pool === "B");
      const oddPool = A.length % 2 === 1 ? "A" : B.length % 2 === 1 ? "B" : "A";
      const poolList = checkinsList.filter((p) => p.pool === oddPool);

      let chosen = null;
      if (mode === "manual" && manualId)
        chosen = poolList.find((p) => p.id === manualId) || null;
      if (!chosen) chosen = shuffle(poolList)[0] || null;
      if (!chosen) return { caliId: "", remaining: [...checkinsList] };

      return {
        caliId: chosen.id,
        remaining: checkinsList.filter((p) => p.id !== chosen.id),
      };
    }

    // random
    let chosen = null;
    if (mode === "manual" && manualId)
      chosen = checkinsList.find((p) => p.id === manualId) || null;
    if (!chosen) chosen = shuffle(checkinsList)[0] || null;
    if (!chosen) return { caliId: "", remaining: [...checkinsList] };

    return {
      caliId: chosen.id,
      remaining: checkinsList.filter((p) => p.id !== chosen.id),
    };
  }

  function buildTeamsAndCards(checkinsList, fmt, caliInfo) {
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
        teams.push({
          id: uid(),
          type: "doubles",
          players: [
            { id: As[i].id, name: As[i].name, pool: "A" },
            { id: Bs[i].id, name: Bs[i].name, pool: "B" },
          ],
        });
      }

      const leftover = [...As.slice(min), ...Bs.slice(min)];
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

    // build cards: 2 teams per card, hole gap of 2
    const cardTeams = [...teams];
    const cardsOut = [];
    let startHole = 1;

    function nextStartHole() {
      const h = startHole;
      startHole += 2;
      return h;
    }

    while (cardTeams.length >= 2) {
      const t1 = cardTeams.shift();
      const t2 = cardTeams.shift();
      cardsOut.push({ id: uid(), startHole: nextStartHole(), teams: [t1, t2] });
