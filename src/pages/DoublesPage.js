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
const APP_VERSION = "v1.6.1-doubles-cali";

function uid() {
  return Math.random().toString(36).substring(2, 10);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startHoleForCardIndex(i) {
  // 1, 3, 5, ... wrap at 18
  const hole = ((1 + 2 * i - 1) % 18) + 1;
  return hole;
}

function clampScore(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.max(-18, Math.min(18, Math.trunc(n)));
}

function caliKeyForPlayer(playerId) {
  return `cali_${playerId}`;
}

export default function DoublesPage() {
  // --- Palette / look (match Putting / Tags vibe) ---
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
    fontWeight: 900,
    cursor: "pointer",
  };

  const smallButtonStyle = {
    ...buttonStyle,
    padding: "8px 12px",
    fontWeight: 900,
  };

  const leagueRef = useMemo(() => doc(db, "leagues", LEAGUE_ID), []);

  // --- Doubles league Firestore shape ---
  const [doubles, setDoubles] = useState({
    settings: {
      format: "random", // "random" | "seated"
      locked: false,
      finalized: false,
      caliMode: "auto", // "auto" | "manual"
    },
    layoutNote: "",
    players: [], // {id,name, group:"A"|"B" (only for seated)}
    caliPlayerId: "", // picked/assigned when odd players
    teams: [], // {id, name, playerIds:[p1,p2]}
    cards: [], // {id, name, teamIds:[...], startHole:number, caliPlayerId?:string}
    scores: {}, // scores[teamId] = -18..18 ; scores[caliKey] = -18..18
    submitted: {}, // submitted[cardId] = true
    adjustments: {}, // adjustments[rowId] = delta (rowId = teamId or caliKey)
  });

  // UI state
  const [adminOpen, setAdminOpen] = useState(true);
  const [checkinOpen, setCheckinOpen] = useState(true);
  const [cardsOpen, setCardsOpen] = useState(true);
  const [leaderboardsOpen, setLeaderboardsOpen] = useState(false);

  const [editOpen, setEditOpen] = useState(false);

  // check-in UI
  const [name, setName] = useState("");
  const [group, setGroup] = useState("A"); // for seated

  // per-card expansion
  const [openCards, setOpenCards] = useState({}); // {cardId: bool}

  // ---------- Derived ----------
  const settings = doubles.settings || {};
  const format = String(settings.format || "random"); // random | seated
  const locked = !!settings.locked;
  const finalized = !!settings.finalized;
  const caliMode = String(settings.caliMode || "auto"); // auto | manual

  const players = Array.isArray(doubles.players) ? doubles.players : [];
  const caliPlayerId = String(doubles.caliPlayerId || "");
  const teams = Array.isArray(doubles.teams) ? doubles.teams : [];
  const cards = Array.isArray(doubles.cards) ? doubles.cards : [];
  const scores =
    doubles.scores && typeof doubles.scores === "object" ? doubles.scores : {};
  const submitted =
    doubles.submitted && typeof doubles.submitted === "object"
      ? doubles.submitted
      : {};
  const adjustments =
    doubles.adjustments && typeof doubles.adjustments === "object"
      ? doubles.adjustments
      : {};
  const layoutNote = String(doubles.layoutNote || "");

  const isOddPlayers = players.length % 2 === 1;

  const playerById = useMemo(() => {
    const map = {};
    players.forEach((p) => (map[p.id] = p));
    return map;
  }, [players]);

  const teamById = useMemo(() => {
    const map = {};
    teams.forEach((t) => (map[t.id] = t));
    return map;
  }, [teams]);

  function baseScoreForRow(rowId) {
    const raw = scores?.[rowId];
    if (raw === undefined || raw === null || raw === "") return null;
    const n = Number(raw);
    return Number.isNaN(n) ? null : n;
  }

  function finalScoreForRow(rowId) {
    const base = baseScoreForRow(rowId);
    const baseNum = base === null ? null : Number(base);
    const adj = Number(adjustments?.[rowId] ?? 0) || 0;
    if (baseNum === null) return null;
    return baseNum + adj;
  }

  function submittedCount() {
    const total = cards.length;
    const s = cards.filter((c) => !!submitted?.[c.id]).length;
    return { submitted: s, total };
  }

  function missingCards() {
    return cards.filter((c) => !submitted?.[c.id]);
  }

  const canFinalize =
    locked &&
    !finalized &&
    cards.length > 0 &&
    submittedCount().submitted === submittedCount().total;

  // After locked, collapse check-in/admin by default (like Putting)
  useEffect(() => {
    if (locked) {
      setCheckinOpen(false);
      setAdminOpen(false);
    }
  }, [locked]);

  // ---------- Admin password gate ----------
  function requireAdmin(fn) {
    const pw = window.prompt("Admin password:");
    if (pw !== ADMIN_PASSWORD) {
      alert("Wrong password.");
      return;
    }
    return fn();
  }

  // ---------- Firestore bootstrap/subscribe ----------
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
          },
          doublesLeague: {
            settings: { format: "random", locked: false, finalized: false, caliMode: "auto" },
            layoutNote: "",
            players: [],
            caliPlayerId: "",
            teams: [],
            cards: [],
            scores: {},
            submitted: {},
            adjustments: {},
          },
        });
      }

      unsub = onSnapshot(leagueRef, (s) => {
        const data = s.data() || {};
        const dl = data.doublesLeague || {};

        const safe = {
          settings: {
            format: "random",
            locked: false,
            finalized: false,
            caliMode: "auto",
            ...(dl.settings || {}),
          },
          layoutNote: dl.layoutNote || "",
          players: Array.isArray(dl.players) ? dl.players : [],
          caliPlayerId: dl.caliPlayerId || "",
          teams: Array.isArray(dl.teams) ? dl.teams : [],
          cards: Array.isArray(dl.cards) ? dl.cards : [],
          scores: dl.scores && typeof dl.scores === "object" ? dl.scores : {},
          submitted: dl.submitted && typeof dl.submitted === "object" ? dl.submitted : {},
          adjustments:
            dl.adjustments && typeof dl.adjustments === "object" ? dl.adjustments : {},
        };

        setDoubles(safe);
      });
    })().catch(console.error);

    return () => unsub();
  }, [leagueRef]);

  async function updateDoubles(patch) {
    await updateDoc(leagueRef, {
      doublesLeague: {
        ...doubles,
        ...patch,
      },
    });
  }

  async function updateDoublesDot(dotPath, value) {
    await updateDoc(leagueRef, {
      [`doublesLeague.${dotPath}`]: value,
    });
  }

  // ---------- Admin actions ----------
  async function setFormat(next) {
    if (locked || finalized) return;
    await updateDoubles({
      settings: { ...settings, format: next },
      // if switching formats before check-in, also clear cali assignment
      caliPlayerId: "",
    });
  }

  async function setCaliMode(next) {
    if (locked || finalized) return;
    await updateDoubles({
      settings: { ...settings, caliMode: next },
      caliPlayerId: "",
    });
  }

  async function setCaliPlayerManual(playerId) {
    if (locked || finalized) return;
    await requireAdmin(async () => {
      await updateDoubles({ caliPlayerId: playerId || "" });
    });
  }

  async function saveLayoutNote(v) {
    await updateDoubles({ layoutNote: v });
  }

  async function addPlayer() {
    if (finalized) {
      alert("Doubles is finalized. Reset Doubles to start over.");
      return;
    }
    if (locked) return;

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
      group: format === "seated" ? (group || "A") : undefined,
    };

    await updateDoubles({ players: [...players, newPlayer] });
    setName("");
    setGroup("A");
  }

  // ---------- Cali picking ----------
  function pickCaliAuto(allPlayers) {
    if (allPlayers.length % 2 === 0) return ""; // no cali needed
    if (format === "seated") {
      const A = allPlayers.filter((p) => (p.group || "A") === "A");
      const B = allPlayers.filter((p) => (p.group || "A") === "B");
      // choose from whichever pool has the odd extra player
      const poolToPick =
        A.length % 2 === 1 ? "A" : B.length % 2 === 1 ? "B" : "A";
      const candidates = allPlayers.filter((p) => (p.group || "A") === poolToPick);
      return shuffle(candidates)[0]?.id || allPlayers[0]?.id || "";
    }
    // random format: random player
    return shuffle(allPlayers)[0]?.id || "";
  }

  function getEffectiveCaliPlayerId(allPlayers) {
    if (allPlayers.length % 2 === 0) return "";
    if (caliMode === "manual") {
      // if admin chose someone valid
      if (caliPlayerId && allPlayers.some((p) => p.id === caliPlayerId)) return caliPlayerId;
      // otherwise not chosen yet
      return "";
    }
    // auto
    return pickCaliAuto(allPlayers);
  }

  // ---------- Team building ----------
  function buildTeamsFromPlayers(allPlayers, effectiveCaliId) {
    const pool = allPlayers.filter((p) => p.id !== effectiveCaliId);

    if (pool.length < 4) {
      return { ok: false, reason: "Not enough players to create teams." };
    }
    if (pool.length % 2 !== 0) {
      return { ok: false, reason: "Internal error: non-cali players must be even." };
    }

    if (format === "random") {
      const shuffled = shuffle(pool);
      const built = [];
      for (let i = 0; i < shuffled.length; i += 2) {
        built.push({
          id: uid(),
          name: `Team ${built.length + 1}`,
          playerIds: [shuffled[i].id, shuffled[i + 1].id],
        });
      }
      return { ok: true, teams: built };
    }

    // seated: pair A with B where possible
    const A = pool.filter((p) => (p.group || "A") === "A");
    const B = pool.filter((p) => (p.group || "A") === "B");

    if (A.length === 0 || B.length === 0) {
      return { ok: false, reason: "Seated Doubles needs at least one A and one B (after Cali)." };
    }

    const a = shuffle(A);
    const b = shuffle(B);

    const built = [];
    const pairs = Math.min(a.length, b.length);
    for (let i = 0; i < pairs; i++) {
      built.push({
        id: uid(),
        name: `Team ${built.length + 1}`,
        playerIds: [a[i].id, b[i].id],
      });
    }

    // leftovers pair together (best-effort) so we still have even teams
    const leftovers = a.slice(pairs).concat(b.slice(pairs));
    if (leftovers.length % 2 !== 0) {
      return {
        ok: false,
        reason:
          "Uneven leftovers after pairing. Add one more player or adjust A/B check-in.",
      };
    }

    const l = shuffle(leftovers);
    for (let i = 0; i < l.length; i += 2) {
      built.push({
        id: uid(),
        name: `Team ${built.length + 1}`,
        playerIds: [l[i].id, l[i + 1].id],
      });
    }

    return { ok: true, teams: built };
  }

  // ---------- Card building ----------
  function buildCards(builtTeams, effectiveCaliId) {
    // Rules:
    // - no single team card
    // - cali cannot be alone
    // - allowed:
    //   * 2 teams (4)
    //   * 2 teams + cali (5)
    //   * 1 team + cali (3)
    //   * 3 teams (6)
    const t = [...builtTeams];
    const cardsOut = [];
    let caliPlaced = false;

    // make 2-team cards as much as possible
    while (t.length >= 2) {
      const chunk = t.splice(0, 2);
      cardsOut.push({
        id: uid(),
        name: `Card ${cardsOut.length + 1}`,
        teamIds: chunk.map((x) => x.id),
        startHole: startHoleForCardIndex(cardsOut.length),
        caliPlayerId: "",
      });
    }

    // leftover single team
    if (t.length === 1) {
      const leftoverTeam = t[0];

      if (effectiveCaliId && !caliPlaced) {
        // Make "1 team + Cali" card (3 people) — allowed
        cardsOut.push({
          id: uid(),
          name: `Card ${cardsOut.length + 1}`,
          teamIds: [leftoverTeam.id],
          startHole: startHoleForCardIndex(cardsOut.length),
          caliPlayerId: effectiveCaliId,
        });
        caliPlaced = true;
      } else {
        // No cali to pair with => must merge into last card to make 3 teams
        if (cardsOut.length === 0) {
          return { ok: false, reason: "Cannot create a card with only one team." };
        }
        const last = cardsOut[cardsOut.length - 1];
        last.teamIds = [...(last.teamIds || []), leftoverTeam.id]; // 3 teams (6 people)
      }
    }

    // if cali exists and not placed yet:
    if (effectiveCaliId && !caliPlaced) {
      // Prefer adding to a 2-team card (becomes 5 people)
      const target =
        cardsOut.find((c) => (c.teamIds || []).length === 2 && !c.caliPlayerId) ||
        cardsOut.find((c) => (c.teamIds || []).length === 1 && !c.caliPlayerId) ||
        null;

      if (!target) {
        return { ok: false, reason: "No valid card to place Cali on." };
      }
      target.caliPlayerId = effectiveCaliId;
      caliPlaced = true;
    }

    // validate no single-team without cali
    for (const c of cardsOut) {
      const teamsCount = (c.teamIds || []).length;
      const hasCali = !!c.caliPlayerId;
      if (teamsCount === 1 && !hasCali) {
        return { ok: false, reason: "A card would have only one team without Cali (not allowed)." };
      }
      if (teamsCount === 0) {
        return { ok: false, reason: "A card has no teams." };
      }
    }

    return { ok: true, cards: cardsOut };
  }

  async function makeTeamsAndCards() {
    if (finalized) return;
    if (locked) {
      alert("Teams are already created. Reset Doubles to start fresh.");
      return;
    }

    if (players.length < 4) {
      alert("Check in at least 4 players first.");
      return;
    }

    // determine cali if needed
    const effectiveCaliId = getEffectiveCaliPlayerId(players);

    if (players.length % 2 === 1 && caliMode === "manual" && !effectiveCaliId) {
      alert("Odd number of players: please select a Cali player (Admin Tools).");
      return;
    }

    // build teams from non-cali players
    const teamsRes = buildTeamsFromPlayers(players, effectiveCaliId);
    if (!teamsRes.ok) {
      alert(teamsRes.reason);
      return;
    }

    const builtTeams = teamsRes.teams;
    if (builtTeams.length < 2 && !effectiveCaliId) {
      alert("Need at least 2 teams.");
      return;
    }

    // build cards with rules
    const cardsRes = buildCards(builtTeams, effectiveCaliId);
    if (!cardsRes.ok) {
      alert(cardsRes.reason);
      return;
    }

    await updateDoubles({
      caliPlayerId: effectiveCaliId || "",
      teams: builtTeams,
      cards: cardsRes.cards,
      scores: {},
      submitted: {},
      adjustments: {},
      settings: { ...settings, locked: true },
    });

    setCardsOpen(true);
    window.scrollTo(0, 0);
  }

  async function finalizeDoubles() {
    if (!canFinalize) {
      alert("Finalize is only available once every card submits.");
      return;
    }
    await updateDoubles({
      settings: { ...settings, finalized: true },
    });
    setEditOpen(false);
    alert("Finalized. Doubles is now locked.");
  }

  async function resetDoubles() {
    await requireAdmin(async () => {
      const ok = window.confirm(
        "Reset DOUBLES only?\n\nThis clears doubles players, Cali, teams, cards, scores, layout note, and leaderboard edits.\n(Tags + Putting will NOT be affected.)"
      );
      if (!ok) return;

      await updateDoc(leagueRef, {
        doublesLeague: {
          settings: { format: "random", locked: false, finalized: false, caliMode: "auto" },
          layoutNote: "",
          players: [],
          caliPlayerId: "",
          teams: [],
          cards: [],
          scores: {},
          submitted: {},
          adjustments: {},
        },
      });

      setOpenCards({});
      setName("");
      setGroup("A");
      setAdminOpen(true);
      setCheckinOpen(true);
      setCardsOpen(true);
      setLeaderboardsOpen(false);
      setEditOpen(false);
    });
  }

  async function toggleLeaderboardEdit() {
    if (finalized) {
      alert("Finalized. Leaderboard edits are locked.");
      return;
    }
    await requireAdmin(async () => setEditOpen((v) => !v));
  }

  async function setFinalLeaderboardScore(rowId, desiredFinal) {
    if (finalized) return;

    const desired = Number(desiredFinal);
    if (Number.isNaN(desired)) return;

    const base = baseScoreForRow(rowId);
    const baseNum = base === null ? 0 : Number(base);

    const adj = Math.trunc(desired - baseNum);
    await updateDoublesDot(`adjustments.${rowId}`, adj);
  }

  async function clearAdjustment(rowId) {
    if (finalized) return;
    await requireAdmin(async () => {
      const path = `doublesLeague.adjustments.${rowId}`;
      await updateDoc(leagueRef, { [path]: deleteField() });
    });
  }

  // ---------- Card scoring ----------
  function toggleCard(cardId) {
    setOpenCards((prev) => ({ ...prev, [cardId]: !prev[cardId] }));
  }

  function scoreValue(rowId) {
    const raw = scores?.[rowId];
    if (raw === undefined || raw === null || raw === "") return "";
    const n = Number(raw);
    return Number.isNaN(n) ? "" : String(n);
  }

  async function setRowScore(rowId, value) {
    if (!locked) return;
    if (finalized) return;

    if (value === "" || value === null || value === undefined) {
      await updateDoc(leagueRef, {
        [`doublesLeague.scores.${rowId}`]: deleteField(),
      });
      return;
    }

    const v = clampScore(value);
    await updateDoc(leagueRef, {
      [`doublesLeague.scores.${rowId}`]: v,
    });
  }

  function isCardReadyToSubmit(card) {
    const tids = card?.teamIds || [];
    const hasCali = !!card?.caliPlayerId;

    // must have at least one team
    if (!tids.length) return false;

    // Each team must have a score
    for (const tid of tids) {
      const raw = scores?.[tid];
      if (raw === undefined || raw === null || raw === "") return false;
      if (Number.isNaN(Number(raw))) return false;
    }

    // If has cali, cali must have score
    if (hasCali) {
      const ck = caliKeyForPlayer(card.caliPlayerId);
      const raw = scores?.[ck];
      if (raw === undefined || raw === null || raw === "") return false;
      if (Number.isNaN(Number(raw))) return false;
    }

    return true;
  }

  async function submitCard(cardId) {
    if (finalized) return;

    const card = cards.find((c) => c.id === cardId);
    if (!card) return;

    if (!!submitted?.[cardId]) return;

    if (!isCardReadyToSubmit(card)) {
      alert("Enter scores for every team (and Cali if present) on this card first.");
      return;
    }

    await updateDoublesDot(`submitted.${cardId}`, true);
    alert("Card submitted ✅");
  }

  // ---------- Leaderboard ----------
  const leaderboardRows = useMemo(() => {
    const rows = [];

    // doubles teams
    teams.forEach((t) => {
      const members = (t.playerIds || [])
        .map((pid) => playerById[pid]?.name)
        .filter(Boolean);

      const base = baseScoreForRow(t.id);
      const adj = Number(adjustments?.[t.id] ?? 0) || 0;
      const final = base === null ? null : base + adj;

      rows.push({
        id: t.id,
        label: t.name,
        members,
        base,
        adj,
        final,
        isCali: false,
      });
    });

    // cali row (once teams/cards are made)
    if (locked && caliPlayerId) {
      const p = playerById[caliPlayerId];
      const rowId = caliKeyForPlayer(caliPlayerId);

      const base = baseScoreForRow(rowId);
      const adj = Number(adjustments?.[rowId] ?? 0) || 0;
      const final = base === null ? null : base + adj;

      rows.push({
        id: rowId,
        label: p ? `${p.name} (Cali)` : "Cali",
        members: p ? [p.name] : [],
        base,
        adj,
        final,
        isCali: true,
      });
    }

    // Sort: by final score ascending (best under par first).
    // If not submitted yet (null), push to bottom.
    rows.sort((a, b) => {
      if (a.final === null && b.final === null) return 0;
      if (a.final === null) return 1;
      if (b.final === null) return -1;
      return a.final - b.final;
    });

    return rows;
  }, [teams, playerById, scores, adjustments, locked, caliPlayerId]);

  // ---------- UI helpers ----------
  const submitStats = locked ? submittedCount() : { submitted: 0, total: 0 };
  const missing = locked ? missingCards() : [];

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

          <div style={{ color: COLORS.green, marginTop: 14, marginBottom: 12, fontWeight: 900 }}>
            Doubles League{" "}
            {locked ? (
              <span style={{ color: COLORS.navy }}>— In progress</span>
            ) : (
              <span style={{ opacity: 0.75, fontWeight: 800 }}>— Not started</span>
            )}
            {finalized ? (
              <div style={{ marginTop: 6, color: COLORS.red, fontWeight: 900 }}>
                FINALIZED (locked)
              </div>
            ) : null}
          </div>

          {/* Admin status (who hasn't submitted) */}
          {locked && (
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 14 }}>
              <div>
                Admin Status: Cards submitted —{" "}
                <strong>
                  {submitStats.submitted} / {submitStats.total}
                </strong>
              </div>

              {missing.length > 0 ? (
                <div style={{ marginTop: 6 }}>
                  Waiting on:{" "}
                  <strong style={{ color: COLORS.red }}>
                    {missing.map((c) => c.name).join(", ")}
                  </strong>
                </div>
              ) : (
                <div style={{ marginTop: 6, color: COLORS.green, fontWeight: 900 }}>
                  All cards submitted ✅
                </div>
              )}
            </div>
          )}

          {/* Layout note shown to players */}
          {layoutNote ? (
            <div
              style={{
                marginBottom: 12,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 14,
                background: COLORS.soft,
                padding: 12,
                textAlign: "left",
              }}
            >
              <div style={{ fontWeight: 900, color: COLORS.navy, marginBottom: 6 }}>
                Layout
              </div>
              <div style={{ fontSize: 14, whiteSpace: "pre-wrap" }}>{layoutNote}</div>
            </div>
          ) : null}

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
              onClick={() => setAdminOpen((v) => !v)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 900, color: COLORS.navy }}>Admin Tools</div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {adminOpen ? "Tap to collapse" : "Tap to expand"}
              </div>
            </div>

            {adminOpen && (
              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                {/* Format selector */}
                <div
                  style={{
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 12,
                    background: "#fff",
                    padding: 10,
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 900, color: COLORS.navy, marginBottom: 6 }}>
                    Doubles Format
                  </div>

                  <div style={{ display: "grid", gap: 8 }}>
                    <button
                      onClick={() => setFormat("seated")}
                      disabled={locked || finalized}
                      style={{
                        ...smallButtonStyle,
                        width: "100%",
                        background: format === "seated" ? COLORS.navy : "#fff",
                        color: format === "seated" ? "white" : COLORS.navy,
                        border: `1px solid ${COLORS.navy}`,
                      }}
                      title="Pairs A + B together (when possible)"
                    >
                      Seated Doubles
                    </button>

                    <button
                      onClick={() => setFormat("random")}
                      disabled={locked || finalized}
                      style={{
                        ...smallButtonStyle,
                        width: "100%",
                        background: format === "random" ? COLORS.navy : "#fff",
                        color: format === "random" ? "white" : COLORS.navy,
                        border: `1px solid ${COLORS.navy}`,
                      }}
                      title="Random pairs"
                    >
                      Random Doubles
                    </button>

                    <div style={{ fontSize: 12, opacity: 0.75 }}>
                      Format is locked once teams/cards are created.
                    </div>
                  </div>
                </div>

                {/* Cali mode */}
                <div
                  style={{
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 12,
                    background: "#fff",
                    padding: 10,
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 900, color: COLORS.navy, marginBottom: 6 }}>
                    Cali Mode
                  </div>

                  <div style={{ display: "grid", gap: 8 }}>
                    <button
                      onClick={() => setCaliMode("auto")}
                      disabled={locked || finalized}
                      style={{
                        ...smallButtonStyle,
                        width: "100%",
                        background: caliMode === "auto" ? COLORS.navy : "#fff",
                        color: caliMode === "auto" ? "white" : COLORS.navy,
                        border: `1px solid ${COLORS.navy}`,
                      }}
                      title="If odd players, auto-picks Cali (Seated: from odd pool)"
                    >
                      Auto Cali (Random)
                    </button>

                    <button
                      onClick={() => setCaliMode("manual")}
                      disabled={locked || finalized}
                      style={{
                        ...smallButtonStyle,
                        width: "100%",
                        background: caliMode === "manual" ? COLORS.navy : "#fff",
                        color: caliMode === "manual" ? "white" : COLORS.navy,
                        border: `1px solid ${COLORS.navy}`,
                      }}
                      title="Admin selects Cali if players are odd"
                    >
                      Admin Selects Cali
                    </button>

                    {caliMode === "manual" && !locked ? (
                      isOddPlayers ? (
                        <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
                          <div style={{ fontSize: 12, opacity: 0.8 }}>
                            Odd number of players detected — select who is Cali:
                          </div>

                          <select
                            value={caliPlayerId}
                            onChange={(e) => setCaliPlayerManual(e.target.value)}
                            style={{ ...inputStyle, width: "100%", background: "#fff" }}
                            disabled={finalized}
                          >
                            <option value="">Select Cali…</option>
                            {players.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                                {format === "seated" ? ` (${(p.group || "A") === "B" ? "B" : "A"})` : ""}
                              </option>
                            ))}
                          </select>

                          <div style={{ fontSize: 12, opacity: 0.75 }}>
                            {format === "seated"
                              ? "Note: In Seated Doubles, Cali should be from the pool (A/B) that has the odd extra player."
                              : "Note: Cali will be the single player (not part of a doubles team)."}
                          </div>
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
                          Manual Cali selection will appear when player count becomes odd.
                        </div>
                      )
                    ) : null}
                  </div>
                </div>

                {/* Layout box */}
                <div
                  style={{
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 12,
                    background: "#fff",
                    padding: 10,
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 900, color: COLORS.navy, marginBottom: 6 }}>
                    Layout (shown to players)
                  </div>
                  <textarea
                    value={layoutNote}
                    onChange={(e) => saveLayoutNote(e.target.value)}
                    placeholder="Example: 'Shotgun start. Card 1 hole 1, Card 2 hole 3… OB is creek. Drop zone on 7.'"
                    style={{
                      ...inputStyle,
                      width: "100%",
                      minHeight: 90,
                      resize: "vertical",
                      background: "#fff",
                      fontFamily: "inherit",
                    }}
                    disabled={finalized}
                  />
                </div>

                {/* Make teams/cards */}
                {!locked ? (
                  <button
                    onClick={makeTeamsAndCards}
                    disabled={finalized || players.length < 4}
                    style={{
                      ...buttonStyle,
                      width: "100%",
                      background: COLORS.green,
                      color: "white",
                      border: `1px solid ${COLORS.green}`,
                    }}
                    title="Creates teams and assigns starting holes (1,3,5...)."
                  >
                    Make Teams + Assign Cards
                  </button>
                ) : (
                  <div style={{ fontSize: 12, opacity: 0.75 }}>Teams/cards locked.</div>
                )}

                {/* Leaderboard edit */}
                <button
                  onClick={toggleLeaderboardEdit}
                  style={{
                    ...smallButtonStyle,
                    width: "100%",
                    background: "#fff",
                    border: `1px solid ${COLORS.navy}`,
                    color: COLORS.navy,
                  }}
                  disabled={finalized || !locked}
                  title="Requires admin password. Set final leaderboard scores before finalize."
                >
                  {editOpen ? "Close Leaderboard Edit" : "Edit Leaderboard Scores"}
                </button>

                {editOpen && !finalized && locked && (
                  <div
                    style={{
                      border: `1px solid ${COLORS.border}`,
                      borderRadius: 12,
                      background: "#fff",
                      padding: 10,
                    }}
                  >
                    <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
                      Set a row’s <strong>final score</strong>. This creates an adjustment
                      (positive or negative). Disabled after Finalize.
                    </div>

                    <div style={{ display: "grid", gap: 8 }}>
                      {leaderboardRows.map((r) => {
                        const base = r.base === null ? 0 : r.base;
                        const total = r.final === null ? base + (r.adj || 0) : r.final;

                        return (
                          <div
                            key={r.id}
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
                              <div style={{ fontWeight: 900, color: COLORS.text }}>
                                {r.label}
                              </div>
                              <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
                                Base: <strong>{r.base === null ? "—" : r.base}</strong> • Adj:{" "}
                                <strong style={{ color: r.adj ? COLORS.red : COLORS.navy }}>
                                  {r.adj || 0}
                                </strong>{" "}
                                • Final: <strong>{r.final === null ? "—" : r.final}</strong>
                              </div>
                            </div>

                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                              <input
                                type="number"
                                value={String(total)}
                                onChange={(e) => setFinalLeaderboardScore(r.id, e.target.value)}
                                style={{
                                  ...inputStyle,
                                  width: 96,
                                  textAlign: "center",
                                  background: "#fff",
                                  fontWeight: 900,
                                }}
                              />
                              <button
                                onClick={() => clearAdjustment(r.id)}
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

                {/* Finalize */}
                {canFinalize && (
                  <button
                    onClick={finalizeDoubles}
                    style={{
                      ...buttonStyle,
                      width: "100%",
                      background: COLORS.red,
                      color: "white",
                      border: `1px solid ${COLORS.red}`,
                    }}
                    title="Locks Doubles once all cards submit."
                  >
                    Finalize Doubles (Lock)
                  </button>
                )}

                {/* Reset doubles */}
                <button
                  onClick={resetDoubles}
                  style={{
                    ...smallButtonStyle,
                    width: "100%",
                    background: "#fff",
                    border: `1px solid ${COLORS.border}`,
                  }}
                  title="Requires admin password."
                >
                  Reset Doubles
                </button>
              </div>
            )}
          </div>

          {/* CHECK-IN */}
          {!locked && (
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
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <input
                      placeholder="Player name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      style={{ ...inputStyle, width: 240 }}
                      disabled={finalized}
                    />

                    {format === "seated" ? (
                      <select
                        value={group}
                        onChange={(e) => setGroup(e.target.value)}
                        style={{ ...inputStyle, width: 140, background: "#fff" }}
                        disabled={finalized}
                      >
                        <option value="A">A Player</option>
                        <option value="B">B Player</option>
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
                            {caliPlayerId === p.id ? (
                              <span style={{ marginLeft: 8, fontSize: 12, color: COLORS.red, fontWeight: 900 }}>
                                (Cali)
                              </span>
                            ) : null}
                          </div>
                          {format === "seated" ? (
                            <div style={{ fontSize: 12, fontWeight: 900, color: COLORS.navy }}>
                              {(p.group || "A") === "B" ? "B" : "A"}
                            </div>
                          ) : (
                            <div style={{ fontSize: 12, fontWeight: 900, color: COLORS.navy }}>
                              Player
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

                  {players.length > 0 ? (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                      {players.length % 2 === 1 ? (
                        <span>
                          Odd number of players detected — <strong>Cali will be used</strong>.
                          {caliMode === "manual" ? " (Admin must select.)" : " (Auto.)"}
                        </span>
                      ) : (
                        <span>Even number of players — no Cali needed.</span>
                      )}
                    </div>
                  ) : null}
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
              <div style={{ fontWeight: 900, color: COLORS.navy }}>Cards</div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {cardsOpen ? "Tap to collapse" : "Tap to expand"}
              </div>
            </div>

            {cardsOpen && (
              <div style={{ marginTop: 10 }}>
                {!locked ? (
                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    Check in players, choose format + Cali mode, then use{" "}
                    <strong>Make Teams + Assign Cards</strong>.
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
                    {cards.map((c) => {
                      const isOpen = !!openCards[c.id];
                      const alreadySubmitted = !!submitted?.[c.id];
                      const caliOnCard = c.caliPlayerId ? playerById[c.caliPlayerId] : null;
                      const teamObjs = (c.teamIds || []).map((tid) => teamById[tid]).filter(Boolean);

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
                            onClick={() => toggleCard(c.id)}
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
                                (Start hole {c.startHole})
                              </span>
                              <span style={{ marginLeft: 10, fontSize: 12, opacity: 0.75 }}>
                                {alreadySubmitted ? "✓ submitted" : "not submitted"}
                              </span>
                            </div>
                            <div style={{ fontSize: 12, opacity: 0.75 }}>
                              {isOpen ? "Tap to collapse" : "Tap to expand"}
                            </div>
                          </div>

                          {isOpen && (
                            <div style={{ padding: 12 }}>
                              {/* Teams display */}
                              <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
                                Starting hole: <strong>{c.startHole}</strong>
                              </div>

                              <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
                                {teamObjs.map((t) => {
                                  const names = (t.playerIds || [])
                                    .map((pid) => playerById[pid]?.name)
                                    .filter(Boolean);
                                  return (
                                    <div
                                      key={t.id}
                                      style={{
                                        padding: "10px 12px",
                                        borderRadius: 12,
                                        border: `1px solid ${COLORS.border}`,
                                        background: COLORS.soft,
                                      }}
                                    >
                                      <div style={{ fontWeight: 900, color: COLORS.navy }}>
                                        {t.name}
                                      </div>
                                      <div style={{ marginTop: 6, fontSize: 14, fontWeight: 800 }}>
                                        {names.join(" + ")}
                                      </div>

                                      <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
                                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                                          Score (relative par)
                                        </div>
                                        <select
                                          value={scoreValue(t.id)}
                                          disabled={alreadySubmitted || finalized}
                                          onChange={(e) => setRowScore(t.id, e.target.value)}
                                          style={{
                                            ...inputStyle,
                                            width: 120,
                                            background: "#fff",
                                            fontWeight: 900,
                                            textAlign: "center",
                                          }}
                                        >
                                          <option value="">—</option>
                                          {Array.from({ length: 37 }, (_, i) => i - 18).map((n) => (
                                            <option key={n} value={n}>
                                              {n > 0 ? `+${n}` : `${n}`}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                    </div>
                                  );
                                })}

                                {/* Cali display if present */}
                                {caliOnCard ? (
                                  <div
                                    style={{
                                      padding: "10px 12px",
                                      borderRadius: 12,
                                      border: `1px solid ${COLORS.border}`,
                                      background: "#fff7f7",
                                    }}
                                  >
                                    <div style={{ fontWeight: 900, color: COLORS.red }}>
                                      Cali
                                    </div>
                                    <div style={{ marginTop: 6, fontSize: 14, fontWeight: 900 }}>
                                      {caliOnCard.name}
                                    </div>

                                    <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
                                      <div style={{ fontSize: 12, opacity: 0.75 }}>
                                        Score (relative par)
                                      </div>
                                      <select
                                        value={scoreValue(caliKeyForPlayer(caliOnCard.id))}
                                        disabled={alreadySubmitted || finalized}
                                        onChange={(e) =>
                                          setRowScore(caliKeyForPlayer(caliOnCard.id), e.target.value)
                                        }
                                        style={{
                                          ...inputStyle,
                                          width: 120,
                                          background: "#fff",
                                          fontWeight: 900,
                                          textAlign: "center",
                                        }}
                                      >
                                        <option value="">—</option>
                                        {Array.from({ length: 37 }, (_, i) => i - 18).map((n) => (
                                          <option key={n} value={n}>
                                            {n > 0 ? `+${n}` : `${n}`}
                                          </option>
                                        ))}
                                      </select>
                                    </div>
                                  </div>
                                ) : null}
                              </div>

                              <button
                                onClick={() => submitCard(c.id)}
                                disabled={alreadySubmitted || finalized}
                                style={{
                                  ...buttonStyle,
                                  width: "100%",
                                  background: alreadySubmitted ? "#ddd" : COLORS.green,
                                  color: alreadySubmitted ? "#444" : "white",
                                  border: `1px solid ${alreadySubmitted ? "#ddd" : COLORS.green}`,
                                }}
                                title="Requires scores for every team (and Cali if present)."
                              >
                                {alreadySubmitted ? "Card Submitted (Locked)" : "Submit Card Scores"}
                              </button>

                              <div
                                style={{
                                  marginTop: 8,
                                  fontSize: 12,
                                  opacity: 0.75,
                                  textAlign: "center",
                                }}
                              >
                                Submitting locks this card. Leaderboard updates live.
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

          {/* LEADERBOARD */}
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
              <span>Leaderboard (Live)</span>
              <span style={{ fontSize: 12, opacity: 0.75 }}>
                {leaderboardsOpen ? "Tap to hide" : "Tap to show"}
              </span>
            </div>

            {leaderboardsOpen && (
              <div
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
                    background: COLORS.soft,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div style={{ fontWeight: 900, color: COLORS.navy }}>
                    Rows: <span style={{ opacity: 0.75 }}>{leaderboardRows.length}</span>
                  </div>
                  {finalized ? (
                    <div style={{ fontSize: 12, fontWeight: 900, color: COLORS.red }}>
                      FINALIZED
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.75 }}>Updates as cards submit</div>
                  )}
                </div>

                <div style={{ padding: 12 }}>
                  {leaderboardRows.length === 0 ? (
                    <div style={{ fontSize: 12, opacity: 0.75 }}>
                      No teams yet. Make teams to start.
                    </div>
                  ) : (
                    <div style={{ display: "grid", gap: 8 }}>
                      {leaderboardRows.map((r, idx) => (
                        <div
                          key={r.id}
                          style={{
                            padding: "10px 12px",
                            borderRadius: 12,
                            border: `1px solid ${COLORS.border}`,
                            background: r.isCali ? "#fff7f7" : COLORS.soft,
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 10,
                          }}
                        >
                          <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
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
                                background: idx === 0 ? COLORS.green : COLORS.navy,
                                flexShrink: 0,
                              }}
                            >
                              {idx + 1}
                            </div>

                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 900, color: COLORS.text }}>
                                {r.label}
                                {r.adj ? (
                                  <span style={{ fontSize: 12, marginLeft: 8, opacity: 0.75 }}>
                                    (adj {r.adj > 0 ? "+" : ""}
                                    {r.adj})
                                  </span>
                                ) : null}
                              </div>
                              {r.members?.length ? (
                                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
                                  {r.members.join(" + ")}
                                </div>
                              ) : null}
                            </div>
                          </div>

                          <div style={{ fontWeight: 900, color: COLORS.navy, whiteSpace: "nowrap" }}>
                            {r.final === null ? "—" : r.final > 0 ? `+${r.final}` : `${r.final}`}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div style={{ marginTop: 18, fontSize: 12, opacity: 0.65, textAlign: "center" }}>
            Tip: Starting holes space out by 2 (1, 3, 5...). Cards expand for scoring. Leaderboard
            updates live as cards submit.
          </div>

          {/* Footer */}
          <div style={{ marginTop: 14, fontSize: 12, opacity: 0.55, textAlign: "center" }}>
            {APP_VERSION} • Developed by Eli Morgan
          </div>
        </div>
      </div>
    </div>
  );
}