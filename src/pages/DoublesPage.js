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

  const groups = [];
  for (const r of rowsSorted) {
    const last = groups[groups.length - 1];
    if (!last || last.score !== r.score)
      groups.push({ score: r.score, members: [r] });
    else last.members.push(r);
  }

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
  const { leagueId } = useParams();

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

  const [doubles, setDoubles] = useState(null);

  const [todayExpanded, setTodayExpanded] = useState(true);
  const [checkinExpanded, setCheckinExpanded] = useState(true);
  const [adminExpanded, setAdminExpanded] = useState(false);

  const [checkinName, setCheckinName] = useState("");
  const [checkinPool, setCheckinPool] = useState("A");

  const [startRoundMsg, setStartRoundMsg] = useState("");
  const [startRoundMsgColor, setStartRoundMsgColor] = useState(COLORS.muted);

  const [formatChoice, setFormatChoice] = useState("random");
  const [caliMode, setCaliMode] = useState("random");
  const [manualCaliId, setManualCaliId] = useState("");
  const [layoutNote, setLayoutNote] = useState("");

  const [expandedCardId, setExpandedCardId] = useState(null);

  const [scoreDraftByTeam, setScoreDraftByTeam] = useState({});
  const [submitMsgByCard, setSubmitMsgByCard] = useState({});
  const [submitMsgColorByCard, setSubmitMsgColorByCard] = useState({});

  const [editHolesOpen, setEditHolesOpen] = useState(false);
  const [holeEdits, setHoleEdits] = useState({});

  const [lateName, setLateName] = useState("");
  const [latePool, setLatePool] = useState("A");
  const [lateCardId, setLateCardId] = useState("");
  const [lateMsg, setLateMsg] = useState("");

  const [payoutsOpen, setPayoutsOpen] = useState(false);
  const [payoutEnabled, setPayoutEnabled] = useState(
    !!DEFAULT_PAYOUT_CONFIG.enabled
  );
  const [payoutBuyIn, setPayoutBuyIn] = useState(
    DEFAULT_PAYOUT_CONFIG.buyInDollars
  );
  const [payoutFeePct, setPayoutFeePct] = useState(
    DEFAULT_PAYOUT_CONFIG.leagueFeePct
  );

  const [adminOkUntil, setAdminOkUntil] = useState(0);

  const defaultDoubles = useMemo(
    () => ({
      started: false,
      format: "random",
      caliMode: "random",
      manualCaliId: "",
      layoutNote: "",
      checkins: [],
      cali: { playerId: "", teammateId: "" },
      cards: [],
      submissions: {},
      leaderboard: [],
      payoutConfig: { ...DEFAULT_PAYOUT_CONFIG },
      payoutsPosted: {},
      updatedAt: Date.now(),
    }),
    []
  );

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

          setFormatChoice(safe.format || "random");
          setCaliMode(safe.caliMode || "random");
          setManualCaliId(safe.manualCaliId || "");
          setLayoutNote(safe.layoutNote || "");

          const enabled =
            safe.payoutConfig?.enabled === undefined
              ? !!DEFAULT_PAYOUT_CONFIG.enabled
              : !!safe.payoutConfig.enabled;
          setPayoutEnabled(enabled);

          setPayoutBuyIn(clampInt(safe.payoutConfig?.buyInDollars, 0, 50));
          setPayoutFeePct(clampInt(safe.payoutConfig?.leagueFeePct, 0, 50));

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
    doubles?.payoutsPosted && typeof doubles?.payoutsPosted === "object"
      ? doubles.payoutsPosted
      : {};

  const payoutsAreEnabled = payoutConfig?.enabled !== false;
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
    }

    if (cardTeams.length === 1 && cardsOut.length > 0) {
      cardsOut[cardsOut.length - 1].teams.push(cardTeams[0]);
    }

    let cali = { playerId: "", teammateId: "" };
    if (caliPlayer) {
      cali.playerId = caliPlayer.id;

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

      if (cardsOut.length > 0) cardsOut[0].teams.push(caliTeam);
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

  async function handleStartRound() {
    setStartRoundMsg("");
    setStartRoundMsgColor(COLORS.muted);

    if (started) {
      setStartRoundMsgColor(COLORS.red);
      setStartRoundMsg("Round already started.");
      return;
    }

    if (checkins.length < 4) {
      setStartRoundMsgColor(COLORS.red);
      setStartRoundMsg("Need at least 4 players checked in to start doubles.");
      return;
    }

    await requireAdmin(async () => {
      try {
        setStartRoundMsgColor(COLORS.muted);
        setStartRoundMsg("Creating teams & cards…");

        const fmt = formatChoice;
        const mode = caliMode;
        const manualId = mode === "manual" ? manualCaliId : "";

        const caliInfo = pickCali(checkins, fmt, mode, manualId);
        const built = buildTeamsAndCards(checkins, fmt, caliInfo);

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
          "doubles.payoutsPosted": {},
          "doubles.updatedAt": Date.now(),
        });

        setStartRoundMsgColor(COLORS.green);
        setStartRoundMsg("✅ Teams & cards created. Cards are now available.");
        setTodayExpanded(false);
        setCheckinExpanded(false);
      } catch (err) {
        setStartRoundMsgColor(COLORS.red);
        setStartRoundMsg(
          `❌ Failed to start round: ${err?.message || String(err)}`
        );
      }
    });
  }

  async function eraseDoublesInfo() {
    await requireAdmin(async () => {
      await updateDoc(leagueRef, {
        doubles: defaultDoubles,
        "doubles.updatedAt": Date.now(),
      });

      setExpandedCardId(null);
      setScoreDraftByTeam({});
      setSubmitMsgByCard({});
      setSubmitMsgColorByCard({});
      setHoleEdits({});
      setLateMsg("");
      setLateName("");
      setCheckinName("");
      setStartRoundMsg("");
      setAdminExpanded(false);
      setPayoutsOpen(false);
      alert("Doubles reset.");
    });
  }

  async function submitCardScores(cardId) {
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;

    setSubmitMsgByCard((m) => ({ ...m, [cardId]: "" }));
    setSubmitMsgColorByCard((m) => ({ ...m, [cardId]: COLORS.muted }));

    const missing = [];
    const nextSubmissions = { ...submissions };

    for (const t of card.teams || []) {
      const raw = scoreDraftByTeam[t.id];

      // allow 0; disallow empty
      if (raw === "" || raw === null || raw === undefined) {
        missing.push(teamDisplay(t));
        continue;
      }

      const n = Number(raw);
      const score = clamp(Number.isNaN(n) ? 0 : n, -18, 18);

      nextSubmissions[t.id] = {
        submittedAt: Date.now(),
        score,
        label: scoreLabel(score),
        playersText: teamPlayersText(t),
        teamName: t.type === "cali" ? "Cali" : "Team",
        cardId,
      };
    }

    if (missing.length) {
      setSubmitMsgColorByCard((m) => ({ ...m, [cardId]: COLORS.red }));
      setSubmitMsgByCard((m) => ({
        ...m,
        [cardId]:
          "Missing scores for: " + missing.join(", ") + ". (0 is allowed.)",
      }));
      return;
    }

    const lb = Object.entries(nextSubmissions).map(([id, s]) => ({
      teamId: id,
      teamName: s.teamName || "Team",
      playersText: s.playersText || "",
      score: Number(s.score ?? 0),
    }));
    lb.sort((a, b) => a.score - b.score);

    await updateDoc(leagueRef, {
      "doubles.submissions": nextSubmissions,
      "doubles.leaderboard": lb,
      "doubles.updatedAt": Date.now(),
    });

    setSubmitMsgColorByCard((m) => ({ ...m, [cardId]: COLORS.green }));
    setSubmitMsgByCard((m) => ({
      ...m,
      [cardId]: "✅ Card scores submitted.",
    }));

    setTimeout(() => {
      setSubmitMsgByCard((m) => ({ ...m, [cardId]: "" }));
    }, 2500);
  }

  async function saveStartingHoleEdits() {
    await requireAdmin(async () => {
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
      alert("Starting holes updated.");
    });
  }

  function findOpenCaliTeam(cardsList) {
    for (const c of cardsList) {
      const t = (c.teams || []).find((x) => x.type === "cali");
      if (t && (t.players || []).length === 1)
        return { cardId: c.id, teamId: t.id };
    }
    return null;
  }

  async function addLatePlayer() {
    await requireAdmin(async () => {
      setLateMsg("");

      const name = lateName.trim();
      if (!name) return;

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
                {
                  id: newPlayer.id,
                  name: newPlayer.name,
                  pool: newPlayer.pool,
                },
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

      const targetId = lateCardId || (cards[0] ? cards[0].id : "");
      if (!targetId) {
        await updateDoc(leagueRef, {
          "doubles.checkins": newCheckins,
          "doubles.updatedAt": Date.now(),
        });
        setLateMsg("Late player checked in. (No cards exist yet.)");
        setLateName("");
        return;
      }

      const caliTeam = {
        id: uid(),
        type: "cali",
        players: [
          { id: newPlayer.id, name: newPlayer.name, pool: newPlayer.pool },
        ],
      };

      newCards = cards.map((c) => {
        if (c.id !== targetId) return c;
        return { ...c, teams: [...(c.teams || []), caliTeam] };
      });

      await updateDoc(leagueRef, {
        "doubles.checkins": newCheckins,
        "doubles.cards": newCards,
        "doubles.updatedAt": Date.now(),
      });

      setLateMsg("Late player added as Cali on selected card.");
      setLateName("");
    });
  }

  // ----------------- Payout actions (Team payouts) -----------------
  function computeTeamPayoutsCents() {
    if (!payoutsAreEnabled)
      return { ok: false, reason: "Payouts are disabled." };

    const buyIn = clampInt(payoutConfig.buyInDollars, 0, 50);
    const feePct = clampInt(payoutConfig.leagueFeePct, 0, 50);

    const playerCount = checkins.length;
    const teamCount = leaderboard.length;

    if (playerCount <= 0)
      return { ok: false, reason: "No players checked in." };
    if (teamCount <= 0)
      return { ok: false, reason: "No teams on leaderboard yet." };

    const totalPotCents = toCents(buyIn) * playerCount;
    const feeCents = Math.round((totalPotCents * feePct) / 100);
    const potAfterFeeCents = Math.max(0, totalPotCents - feeCents);

    const nPlaces = payoutPlacesForTeamCount(teamCount);
    const shares = sharesByPlaces(nPlaces);

    const rowsSorted = [...leaderboard]
      .map((r) => ({
        teamId: r.teamId,
        score: Number(r.score ?? 0),
      }))
      .sort((a, b) => a.score - b.score);

    const payouts = computeTieAwarePayoutsForTeams(
      rowsSorted,
      shares,
      potAfterFeeCents
    );

    return {
      ok: true,
      payouts,
      meta: {
        buyIn,
        feePct,
        playerCount,
        teamCount,
        totalPotCents,
        feeCents,
        potAfterFeeCents,
        nPlaces,
      },
    };
  }

  async function savePayoutConfig() {
    await requireAdmin(async () => {
      const buyIn = clampInt(payoutBuyIn, 0, 50);
      const feePct = clampInt(payoutFeePct, 0, 50);

      await updateDoc(leagueRef, {
        "doubles.payoutConfig": {
          enabled: !!payoutEnabled,
          buyInDollars: buyIn,
          leagueFeePct: feePct,
          updatedAt: Date.now(),
        },
        "doubles.payoutsPosted": {},
        "doubles.updatedAt": Date.now(),
      });

      setPayoutsOpen(false);
      alert("Payout settings saved ✅ (posted payouts cleared)");
    });
  }

  async function togglePayoutsEnabled(nextEnabled) {
    await requireAdmin(async () => {
      await updateDoc(leagueRef, {
        "doubles.payoutConfig.enabled": !!nextEnabled,
        "doubles.payoutsPosted": {},
        "doubles.updatedAt": Date.now(),
      });

      setPayoutEnabled(!!nextEnabled);
      setPayoutsOpen(false);
      alert(
        nextEnabled
          ? "Payouts enabled ✅ (posted payouts cleared)"
          : "Payouts disabled ✅ (posted payouts cleared)"
      );
    });
  }

  async function postPayoutsToLeaderboard() {
    await requireAdmin(async () => {
      if (!payoutsAreEnabled) {
        alert("Payouts are disabled.");
        return;
      }

      const res = computeTeamPayoutsCents();
      if (!res.ok) {
        alert(res.reason || "Unable to compute payouts.");
        return;
      }

      const ok = window.confirm(
        `Post payouts?\n\nPlayers: ${res.meta.playerCount}\nTeams: ${
          res.meta.teamCount
        }\nPot after fee: $${fromCents(
          res.meta.potAfterFeeCents
        )}\nPaid places: ${
          res.meta.nPlaces
        }\n\nThis will show $ amounts and green placement badges for paid teams.`
      );
      if (!ok) return;

      await updateDoc(leagueRef, {
        "doubles.payoutsPosted": res.payouts,
        "doubles.updatedAt": Date.now(),
      });

      alert("Payouts posted ✅");
    });
  }

  async function clearPostedPayouts() {
    await requireAdmin(async () => {
      const ok = window.confirm("Clear posted payouts from the leaderboard?");
      if (!ok) return;

      await updateDoc(leagueRef, {
        "doubles.payoutsPosted": {},
        "doubles.updatedAt": Date.now(),
      });

      alert("Posted payouts cleared.");
    });
  }

  // ----------------- Styles -----------------
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

  const payoutSummary = `${clampInt(
    payoutConfig.buyInDollars,
    0,
    50
  )} buy-in • ${clampInt(payoutConfig.leagueFeePct, 0, 50)}% fee`;

  return (
    <div style={pageWrap}>
      <div style={container}>
        <Header />

        {/* 1) Today's Format */}
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
            <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
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
                <div style={{ marginTop: 6 }}>
                  <b>Payouts:</b>{" "}
                  {payoutsAreEnabled ? (
                    <>
                      {payoutSummary}
                      {hasPostedPayouts ? (
                        <span
                          style={{
                            marginLeft: 8,
                            fontWeight: 900,
                            color: COLORS.green,
                          }}
                        >
                          • Posted
                        </span>
                      ) : (
                        <span
                          style={{
                            marginLeft: 8,
                            fontWeight: 900,
                            color: COLORS.muted,
                          }}
                        >
                          • Not posted
                        </span>
                      )}
                    </>
                  ) : (
                    <span style={{ fontWeight: 900, color: COLORS.muted }}>
                      Off
                    </span>
                  )}
                </div>
              </div>

              {!started && (
                <div style={{ display: "grid", gap: 10 }}>
                  <button
                    style={{
                      padding: "14px 18px",
                      borderRadius: 14,
                      border: `2px solid ${COLORS.red}`,
                      background: COLORS.red,
                      color: "white",
                      fontWeight: 1000,
                      cursor: "pointer",
                    }}
                    onClick={handleStartRound}
                  >
                    Make Teams & Cards (Admin)
                  </button>

                  {!!startRoundMsg && (
                    <div style={{ fontWeight: 900, color: startRoundMsgColor }}>
                      {startRoundMsg}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 2) Player Check-in (disappears after start) */}
        {!started && (
          <div style={{ marginTop: 14, ...cardStyle }}>
            <div
              style={sectionTitleRow}
              onClick={() => setCheckinExpanded((v) => !v)}
            >
              <div
                style={{ fontWeight: 1000, fontSize: 18, color: COLORS.navy }}
              >
                Player Check-in
              </div>
              <div style={{ color: COLORS.muted, fontWeight: 800 }}>
                {checkinExpanded ? "Hide" : "Show"}
              </div>
            </div>

            {checkinExpanded && (
              <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
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

                {checkins.length > 0 ? (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 15,
                      color: COLORS.muted,
                      fontWeight: 800,
                    }}
                  >
                    Checked in:{" "}
                    {checkins
                      .slice(-12)
                      .map((p) => p.name)
                      .join(", ")}
                    {checkins.length > 12 ? "…" : ""}
                  </div>
                ) : (
                  <div
                    style={{ marginTop: 6, fontSize: 14, color: COLORS.muted }}
                  >
                    Add players as they arrive.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* 3) Cards */}
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
                const isOpen = expandedCardId === c.id;

                const teamIds = (c.teams || []).map((t) => t.id);
                const submittedCount = teamIds.filter(
                  (id) => !!submissions[id]
                ).length;

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
                            color: COLORS.muted,
                            fontWeight: 900,
                          }}
                        >
                          Teams submitted: {submittedCount}/{teamIds.length}
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
                        <div style={{ display: "grid", gap: 10 }}>
                          {(c.teams || []).map((t) => {
                            const sub = submissions[t.id];
                            const statusText = sub
                              ? `Submitted: ${sub.label}`
                              : "Not submitted";
                            const statusColor = sub
                              ? COLORS.green
                              : COLORS.muted;

                            return (
                              <div
                                key={t.id}
                                style={{
                                  padding: 12,
                                  borderRadius: 14,
                                  background: "rgba(27,31,90,0.04)",
                                  border: `1px solid ${COLORS.border}`,
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    gap: 10,
                                  }}
                                >
                                  <div style={{ minWidth: 0 }}>
                                    <div
                                      style={{
                                        fontWeight: 1000,
                                        color: COLORS.navy,
                                      }}
                                    >
                                      {teamDisplay(t)}
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
                                  <div
                                    style={{
                                      fontWeight: 1000,
                                      color: COLORS.navy,
                                    }}
                                  >
                                    {sub ? sub.label : ""}
                                  </div>
                                </div>

                                <div
                                  style={{
                                    marginTop: 10,
                                    display: "grid",
                                    gap: 10,
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: 12,
                                      color: COLORS.muted,
                                      fontWeight: 900,
                                    }}
                                  >
                                    Team Score (Relative Par)
                                  </div>
                                  <input
                                    style={input}
                                    type="number"
                                    min={-18}
                                    max={18}
                                    value={scoreDraftByTeam[t.id] ?? ""}
                                    onChange={(e) =>
                                      setScoreDraftByTeam((s) => ({
                                        ...s,
                                        [t.id]: e.target.value,
                                      }))
                                    }
                                    placeholder="ex: -2, 0, +4"
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        <div
                          style={{ marginTop: 12, display: "grid", gap: 10 }}
                        >
                          <button
                            style={{
                              padding: "14px 18px",
                              borderRadius: 14,
                              border: `2px solid ${COLORS.navy}`,
                              background: COLORS.orange,
                              fontWeight: 1000,
                              cursor: "pointer",
                            }}
                            onClick={() => submitCardScores(c.id)}
                          >
                            Submit Card Scores
                          </button>

                          {!!submitMsgByCard[c.id] && (
                            <div
                              style={{
                                fontWeight: 900,
                                color:
                                  submitMsgColorByCard[c.id] || COLORS.muted,
                              }}
                            >
                              {submitMsgByCard[c.id]}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 4) Leaderboard */}
        {started && (
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
                {leaderboard.map((e) => {
                  const place = tiePlaces[e.teamId] || 1;

                  const payoutCents =
                    payoutsAreEnabled && hasPostedPayouts
                      ? Number(payoutsPosted?.[e.teamId] ?? 0) || 0
                      : 0;

                  const isPaid = payoutCents > 0;
                  const badgeBg = isPaid ? COLORS.green : COLORS.navy;

                  return (
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
                        background: COLORS.soft,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          minWidth: 0,
                        }}
                      >
                        <div
                          style={{
                            width: 42,
                            height: 42,
                            borderRadius: 14,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontWeight: 1000,
                            color: "white",
                            background: badgeBg,
                            flexShrink: 0,
                          }}
                          title={
                            payoutsAreEnabled && hasPostedPayouts
                              ? isPaid
                                ? "Paid out"
                                : "Not paid"
                              : "Placement"
                          }
                        >
                          {place}
                        </div>

                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontWeight: 1000,
                              color: COLORS.navy,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {e.playersText || "Team"}
                            {payoutCents > 0 ? (
                              <span
                                style={{
                                  marginLeft: 10,
                                  fontSize: 12,
                                  fontWeight: 1000,
                                  color: COLORS.green,
                                }}
                              >
                                ${fromCents(payoutCents)}
                              </span>
                            ) : null}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: COLORS.muted,
                              fontWeight: 900,
                            }}
                          >
                            {e.teamName || "Team"}
                            {payoutsAreEnabled && hasPostedPayouts ? (
                              <span
                                style={{
                                  marginLeft: 8,
                                  fontWeight: 900,
                                  color: isPaid ? COLORS.green : COLORS.muted,
                                }}
                              >
                                • {isPaid ? "Paid" : "Not paid"}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      <div
                        style={{
                          fontWeight: 1000,
                          fontSize: 18,
                          color: COLORS.navy,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {scoreLabel(Number(e.score ?? 0))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* 5) Admin */}
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
              {/* Settings */}
              <div style={{ ...cardStyle, padding: 12 }}>
                <div style={{ fontWeight: 1000, color: COLORS.navy }}>
                  Settings
                </div>

                <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button
                      style={{
                        padding: "12px 14px",
                        borderRadius: 12,
                        border: `2px solid ${COLORS.navy}`,
                        background:
                          formatChoice === "seated" ? COLORS.orange : "#fff",
                        fontWeight: 900,
                        cursor: "pointer",
                        flex: 1,
                        minWidth: 220,
                      }}
                      onClick={() => setFormatChoice("seated")}
                    >
                      Seated Doubles (A/B)
                    </button>
                    <button
                      style={{
                        padding: "12px 14px",
                        borderRadius: 12,
                        border: `2px solid ${COLORS.navy}`,
                        background:
                          formatChoice === "random" ? COLORS.orange : "#fff",
                        fontWeight: 900,
                        cursor: "pointer",
                        flex: 1,
                        minWidth: 220,
                      }}
                      onClick={() => setFormatChoice("random")}
                    >
                      Random Doubles
                    </button>
                  </div>

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button
                      style={{
                        padding: "12px 14px",
                        borderRadius: 12,
                        border: `2px solid ${COLORS.navy}`,
                        background:
                          caliMode === "random" ? COLORS.orange : "#fff",
                        fontWeight: 900,
                        cursor: "pointer",
                        flex: 1,
                        minWidth: 220,
                      }}
                      onClick={() => setCaliMode("random")}
                    >
                      Cali: Random (if odd)
                    </button>
                    <button
                      style={{
                        padding: "12px 14px",
                        borderRadius: 12,
                        border: `2px solid ${COLORS.navy}`,
                        background:
                          caliMode === "manual" ? COLORS.orange : "#fff",
                        fontWeight: 900,
                        cursor: "pointer",
                        flex: 1,
                        minWidth: 220,
                      }}
                      onClick={() => setCaliMode("manual")}
                    >
                      Cali: Admin selects (if odd)
                    </button>
                  </div>

                  {caliMode === "manual" && (
                    <select
                      style={input}
                      value={manualCaliId}
                      onChange={(e) => setManualCaliId(e.target.value)}
                    >
                      <option value="">Select Cali player (optional)</option>
                      {checkins.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.pool ? ` (${p.pool})` : ""}
                        </option>
                      ))}
                    </select>
                  )}

                  <textarea
                    style={{ ...input, minHeight: 90, resize: "vertical" }}
                    placeholder='Layout note (ex: "Front 9, skip hole 7" or "Shotgun start, hole gap")'
                    value={layoutNote}
                    onChange={(e) => setLayoutNote(e.target.value)}
                  />

                  <button style={button(true)} onClick={saveAdminSettings}>
                    Save Settings (Admin)
                  </button>
                </div>
              </div>

              {/* Payouts */}
              <div style={{ ...cardStyle, padding: 12 }}>
                <div style={{ fontWeight: 1000, color: COLORS.navy }}>
                  Payouts (Teams)
                </div>

                <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: 12,
                      borderRadius: 14,
                      border: `1px solid ${COLORS.border}`,
                      background: COLORS.soft,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 1000, color: COLORS.navy }}>
                        Enable Payouts
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: COLORS.muted,
                          fontWeight: 900,
                        }}
                      >
                        When Off, payout configuration + posting is hidden.
                      </div>
                    </div>

                    <button
                      style={{
                        padding: "10px 14px",
                        borderRadius: 999,
                        border: `2px solid ${
                          payoutsAreEnabled ? COLORS.green : COLORS.navy
                        }`,
                        background: payoutsAreEnabled ? COLORS.green : "#fff",
                        color: payoutsAreEnabled ? "white" : COLORS.navy,
                        fontWeight: 1000,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                      onClick={() => togglePayoutsEnabled(!payoutsAreEnabled)}
                      title="Toggling clears any posted payouts."
                    >
                      {payoutsAreEnabled ? "On" : "Off"}
                    </button>
                  </div>

                  {payoutsAreEnabled ? (
                    <>
                      <div
                        style={{
                          fontSize: 12,
                          color: COLORS.muted,
                          fontWeight: 900,
                        }}
                      >
                        Current:{" "}
                        <span style={{ color: COLORS.navy }}>
                          {payoutSummary}
                        </span>
                        {hasPostedPayouts ? (
                          <span
                            style={{
                              marginLeft: 8,
                              color: COLORS.green,
                              fontWeight: 1000,
                            }}
                          >
                            • Posted
                          </span>
                        ) : (
                          <span
                            style={{
                              marginLeft: 8,
                              color: COLORS.muted,
                              fontWeight: 1000,
                            }}
                          >
                            • Not posted
                          </span>
                        )}
                      </div>

                      <button
                        style={{
                          ...button(false),
                          border: `2px solid ${COLORS.navy}`,
                          background: "#fff",
                        }}
                        onClick={() =>
                          requireAdmin(async () => {
                            setPayoutsOpen((v) => !v);
                          })
                        }
                      >
                        {payoutsOpen
                          ? "Close Payout Configuration"
                          : "Configure Payouts"}
                      </button>

                      {payoutsOpen && (
                        <div
                          style={{
                            border: `1px solid ${COLORS.border}`,
                            borderRadius: 14,
                            padding: 12,
                            background: COLORS.soft,
                            display: "grid",
                            gap: 10,
                          }}
                        >
                          <label
                            style={{
                              fontSize: 12,
                              fontWeight: 1000,
                              color: COLORS.navy,
                            }}
                          >
                            Buy-In per PLAYER ($)
                            <select
                              style={{ ...input, marginTop: 6 }}
                              value={String(payoutBuyIn)}
                              onChange={(e) => setPayoutBuyIn(e.target.value)}
                            >
                              {rangeOptions(0, 50).map((v) => (
                                <option key={v} value={v}>
                                  {v}
                                </option>
                              ))}
                            </select>
                          </label>

                          <label
                            style={{
                              fontSize: 12,
                              fontWeight: 1000,
                              color: COLORS.navy,
                            }}
                          >
                            League Fee (%)
                            <select
                              style={{ ...input, marginTop: 6 }}
                              value={String(payoutFeePct)}
                              onChange={(e) => setPayoutFeePct(e.target.value)}
                            >
                              {rangeOptions(0, 50).map((v) => (
                                <option key={v} value={v}>
                                  {v}%
                                </option>
                              ))}
                            </select>
                          </label>

                          <button
                            style={{
                              padding: "12px 14px",
                              borderRadius: 12,
                              border: `2px solid ${COLORS.green}`,
                              background: COLORS.green,
                              color: "white",
                              fontWeight: 1000,
                              cursor: "pointer",
                            }}
                            onClick={savePayoutConfig}
                          >
                            Save Payout Settings (Admin)
                          </button>

                          <div
                            style={{
                              fontSize: 12,
                              color: COLORS.muted,
                              fontWeight: 900,
                            }}
                          >
                            Saving clears posted payouts (if any).
                          </div>
                        </div>
                      )}

                      <button
                        style={{
                          padding: "12px 14px",
                          borderRadius: 12,
                          border: `2px solid ${COLORS.red}`,
                          background: "#fff",
                          fontWeight: 1000,
                          cursor: "pointer",
                        }}
                        onClick={postPayoutsToLeaderboard}
                        disabled={leaderboard.length === 0}
                        title={
                          leaderboard.length === 0
                            ? "Need scores on the leaderboard first."
                            : "Posts payouts and turns paid place badges green."
                        }
                      >
                        Post Payouts to Leaderboard (Admin)
                      </button>

                      {hasPostedPayouts && (
                        <button
                          style={{
                            padding: "12px 14px",
                            borderRadius: 12,
                            border: `2px solid ${COLORS.navy}`,
                            background: "#fff",
                            fontWeight: 900,
                            cursor: "pointer",
                          }}
                          onClick={clearPostedPayouts}
                        >
                          Clear Posted Payouts (Admin)
                        </button>
                      )}
                    </>
                  ) : (
                    <div
                      style={{
                        fontSize: 12,
                        color: COLORS.muted,
                        fontWeight: 900,
                        padding: 8,
                      }}
                    >
                      Payouts are currently <b>Off</b>.
                    </div>
                  )}
                </div>
              </div>

              {/* Late player */}
              {started && (
                <div style={{ ...cardStyle, padding: 12 }}>
                  <div style={{ fontWeight: 1000, color: COLORS.navy }}>
                    Add Late Player (Admin)
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

                    <button style={button(true)} onClick={addLatePlayer}>
                      Add Late Player (Admin)
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
                    Starting Holes (Admin)
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
                    <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                      {cards.map((c, i) => (
                        <div
                          key={c.id}
                          style={{
                            display: "flex",
                            gap: 10,
                            alignItems: "center",
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
                          Save (Admin)
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

              <div style={{ display: "flex", justifyContent: "center" }}>
                <button
                  style={{
                    padding: "14px 18px",
                    borderRadius: 14,
                    border: `2px solid ${COLORS.red}`,
                    background: "#fff5f5",
                    fontWeight: 1000,
                    cursor: "pointer",
                    minWidth: 260,
                  }}
                  onClick={eraseDoublesInfo}
                >
                  Erase Doubles Information (Admin)
                </button>
              </div>
            </div>
          )}
        </div>

        <div
          style={{
            marginTop: 14,
            fontSize: 12,
            opacity: 0.6,
            textAlign: "center",
          }}
        >
          {APP_VERSION} • League: {leagueId} • Pot is computed from player
          check-ins (buy-in per player) • Payouts are posted to teams
        </div>

        <div style={{ height: 30 }} />
      </div>
    </div>
  );
}
