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
const APP_VERSION = "v1.6.2-doubles-reorder";

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

function normalizeName(s) {
  return (s || "").trim().replace(/\s+/g, " ");
}

function isValidName(s) {
  return normalizeName(s).length >= 2;
}

function range(min, max) {
  const a = [];
  for (let i = min; i <= max; i++) a.push(i);
  return a;
}

function toLabelPar(n) {
  if (n === 0) return "E";
  return n > 0 ? `+${n}` : `${n}`;
}

export default function DoublesPage() {
  const COLORS = {
    blueLight: "#e6f3ff",
    navy: "#1b1f5a",
    orange: "#f4a83a",
    green: "#2f8f2f",
    red: "#c0392b",
    gray: "#5b5b5b",
    cardBg: "#ffffff",
    shadow: "0 8px 24px rgba(0,0,0,0.08)",
  };

  const leagueRef = useMemo(() => doc(db, "leagues", LEAGUE_ID), []);
  const [loaded, setLoaded] = useState(false);
  const [league, setLeague] = useState(null);

  // UI toggles
  const [showCards, setShowCards] = useState(true);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);

  // Admin auth
  const [adminAuthed, setAdminAuthed] = useState(false);
  const [adminPwInput, setAdminPwInput] = useState("");

  // Player check-in
  const [checkInName, setCheckInName] = useState("");
  const [checkInPool, setCheckInPool] = useState("A"); // for seated doubles

  // Card scoring
  const [scoreInputs, setScoreInputs] = useState({}); // { [cardId]: { [teamId]: parInt } }
  const [submitStatus, setSubmitStatus] = useState({}); // { [cardId]: "ok" | "err" | "" }

  // Admin edit start holes
  const [editStartHolesMode, setEditStartHolesMode] = useState(false);
  const [startHoleEdits, setStartHoleEdits] = useState({}); // { [cardId]: number }

  // Admin: layout text
  const [layoutDraft, setLayoutDraft] = useState("");

  // Basic button style
  const buttonStyle = {
    padding: "12px 14px",
    borderRadius: 14,
    border: `2px solid ${COLORS.navy}`,
    fontWeight: 900,
    cursor: "pointer",
    background: COLORS.orange,
    color: "#1a1a1a",
  };

  const subtleButton = {
    ...buttonStyle,
    background: "#fff",
  };

  const dangerButton = {
    ...buttonStyle,
    background: "#ffecec",
    border: `2px solid ${COLORS.red}`,
    color: COLORS.red,
  };

  // Helpers to read doubles state
  const doubles = league?.doubles || {};
  const settings = doubles?.settings || {};
  const checkIns = doubles?.checkIns || []; // [{ id, name, pool, checkedInAt }]
  const cards = doubles?.cards || []; // [{ id, startHole, teams: [team], submittedAt? }]
  const teams = doubles?.teams || []; // [{ id, name, players[], poolMeta? , cali? }]
  const submissions = doubles?.submissions || {}; // { [teamId]: { teamId, teamName, par, submittedAt, cardId } }
  const leaderboard = useMemo(() => {
    const list = Object.values(submissions || {});
    list.sort(
      (a, b) =>
        (a.par ?? 9999) - (b.par ?? 9999) ||
        (a.teamName || "").localeCompare(b.teamName || "")
    );
    return list;
  }, [submissions]);

  const hasSubmissions = leaderboard.length > 0;

  // Auto behavior requested:
  // - Leaderboard should be above Admin tools by default
  // - Once cards start submitting, leaderboard should expand directly under Layout at the top
  useEffect(() => {
    if (hasSubmissions) setShowLeaderboard(true);
  }, [hasSubmissions]);

  // Firestore live sync
  useEffect(() => {
    let unsub = null;
    (async () => {
      await ensureAnonAuth();
      unsub = onSnapshot(
        leagueRef,
        async (snap) => {
          if (snap.exists()) {
            const data = snap.data();
            setLeague(data);
            setLoaded(true);
            setLayoutDraft(data?.doubles?.layoutText || "");
          } else {
            // initialize minimal doc
            const base = {
              appMeta: { createdAt: Date.now() },
              doubles: {
                appVersion: APP_VERSION,
                settings: {
                  format: "random", // "random" | "seated"
                  holesStartAt: 1,
                  holeSpacing: 2,
                  teamsPerCard: 2, // default 2 teams (4 players). With Cali scenario may become 3 teams.
                  caliMode: "random", // "random" | "manual"
                  manualCaliPlayerId: "",
                },
                layoutText: "",
                checkIns: [],
                teams: [],
                cards: [],
                submissions: {},
              },
            };
            await setDoc(leagueRef, base, { merge: true });
          }
        },
        (err) => {
          console.error("Doubles snapshot error:", err);
          setLoaded(true);
        }
      );
    })();
    return () => unsub && unsub();
  }, [leagueRef]);

  // Derived status: who hasn't submitted yet (by team)
  const unsubmittedTeams = useMemo(() => {
    const t = teams || [];
    const sub = submissions || {};
    return t.filter((x) => !sub[x.id]);
  }, [teams, submissions]);

  // Keep startHole edits in sync when entering edit mode
  useEffect(() => {
    if (!editStartHolesMode) return;
    const map = {};
    (cards || []).forEach((c) => {
      map[c.id] = c.startHole ?? 1;
    });
    setStartHoleEdits(map);
  }, [editStartHolesMode, cards]);

  // If no cards exist, show cards section expanded by default
  useEffect(() => {
    if ((cards || []).length === 0) setShowCards(true);
  }, [cards]);

  // --- Admin auth ---
  function requireAdmin() {
    if (adminAuthed) return true;
    const pw = window.prompt("Admin password:");
    if (pw === ADMIN_PASSWORD) {
      setAdminAuthed(true);
      return true;
    }
    window.alert("Incorrect password.");
    return false;
  }

  async function updateDoubles(pathObj) {
    await updateDoc(leagueRef, pathObj);
  }

  // --- Player check-in ---
  async function handleCheckIn() {
    const name = normalizeName(checkInName);
    if (!isValidName(name)) {
      window.alert("Enter a name (2+ characters).");
      return;
    }

    const format = settings.format || "random";
    const pool = format === "seated" ? checkInPool : "";

    const already = (checkIns || []).some(
      (p) => normalizeName(p.name).toLowerCase() === name.toLowerCase()
    );
    if (already) {
      window.alert("That name is already checked in.");
      return;
    }

    const next = [
      ...(checkIns || []),
      { id: uid(), name, pool, checkedInAt: Date.now() },
    ];

    await updateDoubles({
      "doubles.checkIns": next,
    });

    setCheckInName("");
  }

  // --- Cali logic ---
  function pickCaliIfNeeded(players, format, caliMode, manualId) {
    // Return { playersWithoutCali, caliPlayer|null }
    if (!players || players.length === 0)
      return { playersWithoutCali: [], caliPlayer: null };

    // For seated doubles, cali should be from the pool that has odd count
    if (format === "seated") {
      const A = players.filter((p) => p.pool === "A");
      const B = players.filter((p) => p.pool === "B");
      const oddPool =
        A.length % 2 === 1 ? "A" : B.length % 2 === 1 ? "B" : null;

      if (!oddPool) return { playersWithoutCali: players, caliPlayer: null };

      if (caliMode === "manual" && manualId) {
        const selected = players.find(
          (p) => p.id === manualId && p.pool === oddPool
        );
        if (selected) {
          return {
            caliPlayer: selected,
            playersWithoutCali: players.filter((p) => p.id !== selected.id),
          };
        }
        // If manual invalid, fallback to random within odd pool
      }

      const poolPlayers = players.filter((p) => p.pool === oddPool);
      const chosen =
        poolPlayers[Math.floor(Math.random() * poolPlayers.length)];
      return {
        caliPlayer: chosen,
        playersWithoutCali: players.filter((p) => p.id !== chosen.id),
      };
    }

    // Random doubles: only if odd total
    if (players.length % 2 === 0)
      return { playersWithoutCali: players, caliPlayer: null };

    if (caliMode === "manual" && manualId) {
      const selected = players.find((p) => p.id === manualId);
      if (selected) {
        return {
          caliPlayer: selected,
          playersWithoutCali: players.filter((p) => p.id !== selected.id),
        };
      }
    }

    const chosen = players[Math.floor(Math.random() * players.length)];
    return {
      caliPlayer: chosen,
      playersWithoutCali: players.filter((p) => p.id !== chosen.id),
    };
  }

  function buildTeamsFromCheckins() {
    const format = settings.format || "random";
    const caliMode = settings.caliMode || "random";
    const manualCaliPlayerId = settings.manualCaliPlayerId || "";

    let players = (checkIns || []).map((p) => ({
      id: p.id,
      name: p.name,
      pool: p.pool || "",
    }));

    // Decide cali player (if needed / possible)
    const { caliPlayer, playersWithoutCali } = pickCaliIfNeeded(
      players,
      format,
      caliMode,
      manualCaliPlayerId
    );

    players = playersWithoutCali;

    const createdTeams = [];

    if (format === "seated") {
      const A = shuffle(players.filter((p) => p.pool === "A"));
      const B = shuffle(players.filter((p) => p.pool === "B"));

      // Create paired teams A[i] + B[i]
      const n = Math.min(A.length, B.length);
      for (let i = 0; i < n; i++) {
        createdTeams.push({
          id: uid(),
          players: [A[i].name, B[i].name],
          teamName: `${A[i].name} / ${B[i].name}`,
          cali: false,
          poolMeta: "A+B",
        });
      }

      // Any leftovers (should not happen if cali handled correctly, but guard)
      const leftovers = [...A.slice(n), ...B.slice(n)];
      if (leftovers.length > 0) {
        // Add them as "Cali" single team members if possible by merging into cards later
        leftovers.forEach((x) => {
          createdTeams.push({
            id: uid(),
            players: [x.name],
            teamName: `${x.name} (Cali)`,
            cali: true,
            poolMeta: x.pool,
          });
        });
      }
    } else {
      // random doubles: pair sequentially after shuffle
      const s = shuffle(players);
      for (let i = 0; i < s.length; i += 2) {
        const p1 = s[i];
        const p2 = s[i + 1];
        if (!p2) break;
        createdTeams.push({
          id: uid(),
          players: [p1.name, p2.name],
          teamName: `${p1.name} / ${p2.name}`,
          cali: false,
          poolMeta: "",
        });
      }
    }

    // Add cali player as a special single-member team if present
    let caliTeam = null;
    if (caliPlayer) {
      caliTeam = {
        id: uid(),
        players: [caliPlayer.name],
        teamName: `${caliPlayer.name} (Cali)`,
        cali: true,
        poolMeta: format === "seated" ? caliPlayer.pool : "",
      };
    }

    return { createdTeams, caliTeam };
  }

  function assignCardsFromTeams(createdTeams, caliTeam) {
    const holeStartAt = Number(settings.holesStartAt ?? 1);
    const spacing = Number(settings.holeSpacing ?? 2);
    const baseTeamsPerCard = Number(settings.teamsPerCard ?? 2);

    // Rule: no card can have a single team.
    // Typically: 2 teams per card.
    // If cali exists: cali can be added to an existing card making 3 teams on that card.
    // Also, if numbers make it necessary, allow 3 teams on a card (6 players) so no one is alone.

    let teamsList = [...(createdTeams || [])];

    // If any “cali true” teams exist in createdTeams (from weird leftovers), treat them like caliTeam
    const caliSingles = teamsList.filter(
      (t) => t.cali && t.players.length === 1
    );
    teamsList = teamsList.filter((t) => !(t.cali && t.players.length === 1));

    // Prefer explicit caliTeam
    let cali = caliTeam || (caliSingles.length ? caliSingles[0] : null);

    // Group into cards with baseTeamsPerCard
    const newCards = [];
    let idx = 0;
    while (idx < teamsList.length) {
      const slice = teamsList.slice(idx, idx + baseTeamsPerCard);
      idx += baseTeamsPerCard;
      if (slice.length === 1) {
        // Can't have a card with 1 team — merge into previous card if possible
        if (newCards.length > 0) {
          newCards[newCards.length - 1].teams.push(slice[0]);
        } else {
          // Should not happen, but safeguard by holding for later
          // Add to cali if none (effectively becomes cali-ish)
          if (!cali) {
            cali = {
              id: uid(),
              players: slice[0].players,
              teamName: `${slice[0].teamName} (Cali)`,
              cali: true,
              poolMeta: slice[0].poolMeta || "",
            };
          } else {
            // merge players into cali label (still single team-ish) - not ideal, but avoids "solo card"
            cali.players = [...new Set([...cali.players, ...slice[0].players])];
            cali.teamName = `${cali.players.join(" / ")} (Cali)`;
          }
        }
      } else {
        newCards.push({
          id: uid(),
          teams: slice,
          startHole: holeStartAt + newCards.length * spacing,
          createdAt: Date.now(),
        });
      }
    }

    // If cali exists, attach cali to a card (making 3 teams / 5 people) OR pair cali with another “single team” is not allowed.
    // Best: add cali to the first card (or the last card) to create a 3-team card.
    if (cali) {
      if (newCards.length === 0) {
        // If no cards exist, can't proceed properly
        // Put cali as a team, but still need at least 2 teams total to create a card; caller should guard.
        newCards.push({
          id: uid(),
          teams: [cali],
          startHole: holeStartAt,
          createdAt: Date.now(),
        });
      } else {
        // Add cali to the smallest card (prefer 2-team cards)
        const target =
          newCards.find((c) => (c.teams || []).length === 2) || newCards[0];
        target.teams.push(cali);
      }
    }

    // Final safeguard: remove any card that somehow has 1 team by merging forward/back
    for (let i = 0; i < newCards.length; i++) {
      if ((newCards[i].teams || []).length < 2) {
        if (i > 0) {
          newCards[i - 1].teams = [
            ...newCards[i - 1].teams,
            ...newCards[i].teams,
          ];
          newCards.splice(i, 1);
          i--;
        } else if (newCards.length > 1) {
          newCards[i + 1].teams = [
            ...newCards[i + 1].teams,
            ...newCards[i].teams,
          ];
          newCards.splice(i, 1);
          i--;
        }
      }
    }

    return newCards;
  }

  async function adminMakeTeamsAndCards() {
    if (!requireAdmin()) return;

    if ((checkIns || []).length < 4) {
      window.alert("Need at least 4 players checked in to make teams.");
      return;
    }

    // If seated doubles, need at least one A and one B
    if ((settings.format || "random") === "seated") {
      const A = (checkIns || []).filter((p) => p.pool === "A").length;
      const B = (checkIns || []).filter((p) => p.pool === "B").length;
      if (A < 1 || B < 1) {
        window.alert("Seated Doubles requires players in both pools A and B.");
        return;
      }
    }

    const { createdTeams, caliTeam } = buildTeamsFromCheckins();
    const newCards = assignCardsFromTeams(createdTeams, caliTeam);

    // If somehow we ended with only a single-team card, stop
    const bad = newCards.some((c) => (c.teams || []).length < 2);
    if (bad) {
      window.alert(
        "Could not build valid cards (a card ended with < 2 teams). Add more players and try again."
      );
      return;
    }

    // Persist
    const teamList = [];
    newCards.forEach((c) => (c.teams || []).forEach((t) => teamList.push(t)));

    await updateDoubles({
      "doubles.teams": teamList.map((t) => ({
        id: t.id,
        teamName: t.teamName,
        players: t.players,
        cali: !!t.cali,
        poolMeta: t.poolMeta || "",
      })),
      "doubles.cards": newCards.map((c) => ({
        id: c.id,
        startHole: c.startHole,
        teams: c.teams.map((t) => ({
          id: t.id,
          teamName: t.teamName,
          players: t.players,
          cali: !!t.cali,
          poolMeta: t.poolMeta || "",
        })),
        createdAt: c.createdAt,
        submittedAt: null,
      })),
      "doubles.submissions": {}, // reset submissions
    });

    setSubmitStatus({});
    setScoreInputs({});
    setShowCards(true);
  }

  // --- Card scoring ---
  function getTeamParValue(cardId, teamId) {
    return scoreInputs?.[cardId]?.[teamId] ?? 0;
  }

  function setTeamParValue(cardId, teamId, par) {
    setScoreInputs((prev) => ({
      ...prev,
      [cardId]: {
        ...(prev[cardId] || {}),
        [teamId]: par,
      },
    }));
  }

  async function submitCardScores(card) {
    const cardId = card.id;
    try {
      setSubmitStatus((s) => ({ ...s, [cardId]: "" }));

      // Build submissions updates for each team in card
      const updates = {};
      (card.teams || []).forEach((t) => {
        const par = Number(getTeamParValue(cardId, t.id));
        updates[`doubles.submissions.${t.id}`] = {
          teamId: t.id,
          teamName: t.teamName,
          par: clamp(par, -18, 18),
          cardId,
          submittedAt: Date.now(),
        };
      });

      // Mark card submitted (optional)
      // We’ll set a timestamp at card level too, but keep it lightweight
      const newCards = (cards || []).map((c) =>
        c.id === cardId ? { ...c, submittedAt: Date.now() } : c
      );

      await updateDoubles({
        ...updates,
        "doubles.cards": newCards,
      });

      setSubmitStatus((s) => ({ ...s, [cardId]: "ok" }));
      setTimeout(() => {
        setSubmitStatus((s) => ({ ...s, [cardId]: "" }));
      }, 3500);
    } catch (e) {
      console.error(e);
      setSubmitStatus((s) => ({ ...s, [cardId]: "err" }));
      window.alert("Error submitting card. Try again.");
    }
  }

  // --- Admin actions ---
  async function adminSaveLayout() {
    if (!requireAdmin()) return;
    await updateDoubles({ "doubles.layoutText": layoutDraft || "" });
  }

  async function adminResetDoublesOnly() {
    if (!requireAdmin()) return;
    const ok = window.confirm(
      "Erase Doubles check-ins, teams, cards, submissions, and layout? (Doubles only)"
    );
    if (!ok) return;

    await updateDoubles({
      "doubles.layoutText": "",
      "doubles.checkIns": [],
      "doubles.teams": [],
      "doubles.cards": [],
      "doubles.submissions": {},
      "doubles.settings.manualCaliPlayerId": "",
    });

    setCheckInName("");
    setSubmitStatus({});
    setScoreInputs({});
    setLayoutDraft("");
    setEditStartHolesMode(false);
  }

  async function adminSetFormat(format) {
    if (!requireAdmin()) return;
    await updateDoubles({
      "doubles.settings.format": format,
      // Reset manual cali selection because pools might differ
      "doubles.settings.manualCaliPlayerId": "",
    });
  }

  async function adminSetCaliMode(mode) {
    if (!requireAdmin()) return;
    await updateDoubles({
      "doubles.settings.caliMode": mode,
      ...(mode === "random"
        ? { "doubles.settings.manualCaliPlayerId": "" }
        : {}),
    });
  }

  async function adminSetManualCali(playerId) {
    if (!requireAdmin()) return;
    await updateDoubles({
      "doubles.settings.manualCaliPlayerId": playerId,
    });
  }

  async function adminSaveStartHoles() {
    if (!requireAdmin()) return;
    const next = (cards || []).map((c) => ({
      ...c,
      startHole: clamp(Number(startHoleEdits[c.id] ?? c.startHole ?? 1), 1, 36),
    }));
    await updateDoubles({ "doubles.cards": next });
    setEditStartHolesMode(false);
  }

  const showManualCaliPicker = useMemo(() => {
    const mode = settings.caliMode || "random";
    if (mode !== "manual") return false;

    // Only show picker if odd number of checked-in players (per your requirement)
    const format = settings.format || "random";
    if (format === "seated") {
      const A = (checkIns || []).filter((p) => p.pool === "A").length;
      const B = (checkIns || []).filter((p) => p.pool === "B").length;
      return A % 2 === 1 || B % 2 === 1;
    }
    return (checkIns || []).length % 2 === 1;
  }, [settings.caliMode, settings.format, checkIns]);

  const caliPickerOptions = useMemo(() => {
    const format = settings.format || "random";
    const manualId = settings.manualCaliPlayerId || "";

    if (!showManualCaliPicker) return [];

    if (format === "seated") {
      const A = (checkIns || []).filter((p) => p.pool === "A").length;
      const B = (checkIns || []).filter((p) => p.pool === "B").length;
      const oddPool = A % 2 === 1 ? "A" : B % 2 === 1 ? "B" : null;
      return (checkIns || [])
        .filter((p) => p.pool === oddPool)
        .map((p) => ({
          id: p.id,
          label: `${p.name} (${p.pool})`,
          selected: p.id === manualId,
        }));
    }

    return (checkIns || []).map((p) => ({
      id: p.id,
      label: p.name,
      selected: p.id === manualId,
    }));
  }, [
    settings.format,
    settings.manualCaliPlayerId,
    showManualCaliPicker,
    checkIns,
  ]);

  // --- Render helpers ---
  const sectionCard = (children) => (
    <div
      style={{
        background: COLORS.cardBg,
        borderRadius: 18,
        boxShadow: COLORS.shadow,
        padding: 16,
        marginTop: 14,
        border: "1px solid rgba(0,0,0,0.06)",
      }}
    >
      {children}
    </div>
  );

  const pill = (text, colorBg = "#eef2ff", colorText = COLORS.navy) => (
    <span
      style={{
        display: "inline-block",
        padding: "6px 10px",
        borderRadius: 999,
        background: colorBg,
        color: colorText,
        fontWeight: 900,
        fontSize: 12,
        marginRight: 8,
      }}
    >
      {text}
    </span>
  );

  // IMPORTANT: Leaderboard placement logic requested
  // If has submissions => show (expanded) directly under Layout at top
  // Else => show leaderboard above Admin tools (still above Admin, but later)
  const renderLeaderboardSection = (forceExpanded = false) => {
    const open = forceExpanded ? true : showLeaderboard;

    return sectionCard(
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ fontWeight: 1000, fontSize: 18, color: COLORS.navy }}>
            Leaderboard
          </div>
          {!forceExpanded && (
            <button
              style={subtleButton}
              onClick={() => setShowLeaderboard((v) => !v)}
            >
              {open ? "Hide" : "Show"}
            </button>
          )}
        </div>

        {!open ? null : (
          <div style={{ marginTop: 12 }}>
            {!hasSubmissions ? (
              <div style={{ color: COLORS.gray, fontWeight: 700 }}>
                No submissions yet.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {leaderboard.map((row, idx) => (
                  <div
                    key={row.teamId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 12px",
                      borderRadius: 14,
                      border: "1px solid rgba(0,0,0,0.08)",
                      background: "#fff",
                    }}
                  >
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 10 }}
                    >
                      <div
                        style={{
                          fontWeight: 1000,
                          width: 28,
                          color: COLORS.navy,
                        }}
                      >
                        #{idx + 1}
                      </div>
                      <div style={{ fontWeight: 950 }}>{row.teamName}</div>
                    </div>
                    <div style={{ fontWeight: 1000, color: COLORS.navy }}>
                      {toLabelPar(row.par ?? 0)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  if (!loaded) {
    return (
      <div style={{ minHeight: "100vh", padding: 24, background: "#fff" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <Header />
          {sectionCard(
            <div style={{ fontWeight: 900, color: COLORS.gray }}>
              Loading Doubles…
            </div>
          )}
        </div>
      </div>
    );
  }

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
        <Header />

        {/* TOP: Layout + Status */}
        {sectionCard(
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div>
                <div
                  style={{ fontWeight: 1000, fontSize: 20, color: COLORS.navy }}
                >
                  Doubles
                </div>
                <div
                  style={{
                    marginTop: 6,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                  }}
                >
                  {pill(
                    `Format: ${
                      (settings.format || "random") === "seated"
                        ? "Seated Doubles"
                        : "Random Doubles"
                    }`
                  )}
                  {pill(`Checked In: ${(checkIns || []).length}`)}
                  {pill(`Cards: ${(cards || []).length}`)}
                  {pill(`Submissions: ${leaderboard.length}`)}
                </div>
              </div>

              <div
                style={{
                  textAlign: "right",
                  color: COLORS.gray,
                  fontWeight: 800,
                  fontSize: 12,
                }}
              >
                {APP_VERSION}
              </div>
            </div>

            {/* Submission status */}
            <div style={{ marginTop: 12 }}>
              <div
                style={{
                  fontWeight: 1000,
                  color: COLORS.navy,
                  marginBottom: 8,
                }}
              >
                Submission Status
              </div>
              {(teams || []).length === 0 ? (
                <div style={{ color: COLORS.gray, fontWeight: 700 }}>
                  Teams will appear here after “Make Teams”.
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {unsubmittedTeams.length === 0 ? (
                    pill("All teams submitted ✅", "#eaffea", COLORS.green)
                  ) : (
                    <>
                      {pill(
                        `${unsubmittedTeams.length} team(s) not submitted`,
                        "#fff4e6",
                        "#8a4b00"
                      )}
                      {unsubmittedTeams.slice(0, 8).map((t) => (
                        <span
                          key={t.id}
                          style={{
                            display: "inline-block",
                            padding: "6px 10px",
                            borderRadius: 999,
                            background: "#f4f4f4",
                            fontWeight: 900,
                            fontSize: 12,
                          }}
                        >
                          {t.teamName}
                        </span>
                      ))}
                      {unsubmittedTeams.length > 8 ? (
                        <span
                          style={{
                            color: COLORS.gray,
                            fontWeight: 900,
                            fontSize: 12,
                          }}
                        >
                          +{unsubmittedTeams.length - 8} more
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Layout */}
            <div style={{ marginTop: 14 }}>
              <div
                style={{
                  fontWeight: 1000,
                  color: COLORS.navy,
                  marginBottom: 8,
                }}
              >
                Layout
              </div>
              <div
                style={{
                  padding: 12,
                  borderRadius: 14,
                  border: "1px solid rgba(0,0,0,0.08)",
                  background: "#fff",
                  whiteSpace: "pre-wrap",
                  minHeight: 44,
                  fontWeight: 700,
                  color: layoutDraft?.trim() ? "#111" : COLORS.gray,
                }}
              >
                {layoutDraft?.trim()
                  ? layoutDraft
                  : "No layout notes yet. Admin can add notes below."}
              </div>
            </div>
          </div>
        )}

        {/* If submissions exist: leaderboard expands directly under Layout (top) */}
        {hasSubmissions ? renderLeaderboardSection(true) : null}

        {/* Cards section */}
        {sectionCard(
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div
                style={{ fontWeight: 1000, fontSize: 18, color: COLORS.navy }}
              >
                Cards
              </div>
              <button
                style={subtleButton}
                onClick={() => setShowCards((v) => !v)}
              >
                {showCards ? "Hide" : "Show"}
              </button>
            </div>

            {!showCards ? null : (
              <div style={{ marginTop: 12 }}>
                {(cards || []).length === 0 ? (
                  <div style={{ color: COLORS.gray, fontWeight: 700 }}>
                    No cards yet. Players check in, then Admin makes teams.
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: 12 }}>
                    {(cards || []).map((card) => (
                      <CardBlock
                        key={card.id}
                        card={card}
                        navy={COLORS.navy}
                        gray={COLORS.gray}
                        green={COLORS.green}
                        red={COLORS.red}
                        buttonStyle={buttonStyle}
                        subtleButton={subtleButton}
                        getTeamParValue={getTeamParValue}
                        setTeamParValue={setTeamParValue}
                        submitCardScores={submitCardScores}
                        submitStatus={submitStatus}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* If NO submissions yet: leaderboard should still be above Admin tools */}
        {!hasSubmissions ? renderLeaderboardSection(false) : null}

        {/* Admin section on BOTTOM (requested) */}
        {sectionCard(
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div
                style={{ fontWeight: 1000, fontSize: 18, color: COLORS.navy }}
              >
                Admin Tools
              </div>
              <button
                style={subtleButton}
                onClick={() => setShowAdmin((v) => !v)}
              >
                {showAdmin ? "Hide" : "Show"}
              </button>
            </div>

            {!showAdmin ? null : (
              <div style={{ marginTop: 12, display: "grid", gap: 14 }}>
                {/* Admin Auth */}
                <div
                  style={{
                    padding: 12,
                    borderRadius: 14,
                    border: "1px solid rgba(0,0,0,0.08)",
                    background: "#fff",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div style={{ fontWeight: 900, color: COLORS.navy }}>
                      Admin Access
                    </div>
                    <div
                      style={{
                        fontWeight: 900,
                        color: adminAuthed ? COLORS.green : COLORS.red,
                      }}
                    >
                      {adminAuthed ? "Unlocked" : "Locked"}
                    </div>
                  </div>

                  {!adminAuthed ? (
                    <div
                      style={{
                        marginTop: 10,
                        display: "flex",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <input
                        value={adminPwInput}
                        onChange={(e) => setAdminPwInput(e.target.value)}
                        placeholder="Password"
                        type="password"
                        style={{
                          padding: "12px 12px",
                          borderRadius: 14,
                          border: "1px solid rgba(0,0,0,0.2)",
                          fontWeight: 800,
                          flex: "1 1 200px",
                        }}
                      />
                      <button
                        style={buttonStyle}
                        onClick={() => {
                          if (adminPwInput === ADMIN_PASSWORD) {
                            setAdminAuthed(true);
                            setAdminPwInput("");
                          } else {
                            window.alert("Incorrect password.");
                          }
                        }}
                      >
                        Unlock
                      </button>
                    </div>
                  ) : (
                    <div
                      style={{
                        marginTop: 10,
                        display: "flex",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <button
                        style={subtleButton}
                        onClick={() => setAdminAuthed(false)}
                      >
                        Lock Admin
                      </button>
                    </div>
                  )}
                </div>

                {/* Format selection */}
                <div
                  style={{
                    padding: 12,
                    borderRadius: 14,
                    border: "1px solid rgba(0,0,0,0.08)",
                    background: "#fff",
                  }}
                >
                  <div
                    style={{
                      fontWeight: 900,
                      color: COLORS.navy,
                      marginBottom: 10,
                    }}
                  >
                    Doubles Format
                  </div>

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button
                      style={
                        (settings.format || "random") === "seated"
                          ? buttonStyle
                          : subtleButton
                      }
                      onClick={() => adminSetFormat("seated")}
                    >
                      Seated Doubles
                    </button>
                    <button
                      style={
                        (settings.format || "random") === "random"
                          ? buttonStyle
                          : subtleButton
                      }
                      onClick={() => adminSetFormat("random")}
                    >
                      Random Doubles
                    </button>
                  </div>

                  <div
                    style={{
                      marginTop: 10,
                      color: COLORS.gray,
                      fontWeight: 700,
                    }}
                  >
                    Seated Doubles: pairs A + B. Random Doubles: random
                    pairings.
                  </div>
                </div>

                {/* Cali mode */}
                <div
                  style={{
                    padding: 12,
                    borderRadius: 14,
                    border: "1px solid rgba(0,0,0,0.08)",
                    background: "#fff",
                  }}
                >
                  <div
                    style={{
                      fontWeight: 900,
                      color: COLORS.navy,
                      marginBottom: 10,
                    }}
                  >
                    Cali Mode
                  </div>

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button
                      style={
                        (settings.caliMode || "random") === "random"
                          ? buttonStyle
                          : subtleButton
                      }
                      onClick={() => adminSetCaliMode("random")}
                    >
                      Random Cali
                    </button>
                    <button
                      style={
                        (settings.caliMode || "random") === "manual"
                          ? buttonStyle
                          : subtleButton
                      }
                      onClick={() => adminSetCaliMode("manual")}
                    >
                      Admin Select Cali
                    </button>
                  </div>

                  {showManualCaliPicker ? (
                    <div style={{ marginTop: 12 }}>
                      <div
                        style={{
                          fontWeight: 900,
                          marginBottom: 8,
                          color: COLORS.navy,
                        }}
                      >
                        Select Cali Player (odd player only)
                      </div>
                      <div style={{ display: "grid", gap: 8 }}>
                        {caliPickerOptions.map((opt) => (
                          <button
                            key={opt.id}
                            style={opt.selected ? buttonStyle : subtleButton}
                            onClick={() => adminSetManualCali(opt.id)}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        marginTop: 10,
                        color: COLORS.gray,
                        fontWeight: 700,
                      }}
                    >
                      Manual Cali selector appears only when checked-in player
                      count is odd (or odd pool in seated).
                    </div>
                  )}
                </div>

                {/* Player check-in */}
                <div
                  style={{
                    padding: 12,
                    borderRadius: 14,
                    border: "1px solid rgba(0,0,0,0.08)",
                    background: "#fff",
                  }}
                >
                  <div
                    style={{
                      fontWeight: 900,
                      color: COLORS.navy,
                      marginBottom: 10,
                    }}
                  >
                    Player Check-In
                  </div>

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <input
                      value={checkInName}
                      onChange={(e) => setCheckInName(e.target.value)}
                      placeholder="Player name"
                      style={{
                        padding: "12px 12px",
                        borderRadius: 14,
                        border: "1px solid rgba(0,0,0,0.2)",
                        fontWeight: 800,
                        flex: "1 1 220px",
                      }}
                    />

                    {(settings.format || "random") === "seated" ? (
                      <select
                        value={checkInPool}
                        onChange={(e) => setCheckInPool(e.target.value)}
                        style={{
                          padding: "12px 12px",
                          borderRadius: 14,
                          border: "1px solid rgba(0,0,0,0.2)",
                          fontWeight: 900,
                        }}
                      >
                        <option value="A">Pool A</option>
                        <option value="B">Pool B</option>
                      </select>
                    ) : null}

                    <button style={buttonStyle} onClick={handleCheckIn}>
                      Check In
                    </button>
                  </div>

                  <div
                    style={{
                      marginTop: 12,
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                    }}
                  >
                    {(checkIns || []).length === 0 ? (
                      <span style={{ color: COLORS.gray, fontWeight: 700 }}>
                        No one checked in yet.
                      </span>
                    ) : (
                      (checkIns || []).map((p) => (
                        <span
                          key={p.id}
                          style={{
                            padding: "6px 10px",
                            borderRadius: 999,
                            background: "#f4f4f4",
                            fontWeight: 900,
                            fontSize: 12,
                          }}
                        >
                          {p.name}
                          {(settings.format || "random") === "seated"
                            ? ` (${p.pool})`
                            : ""}
                        </span>
                      ))
                    )}
                  </div>
                </div>

                {/* Layout editor */}
                <div
                  style={{
                    padding: 12,
                    borderRadius: 14,
                    border: "1px solid rgba(0,0,0,0.08)",
                    background: "#fff",
                  }}
                >
                  <div
                    style={{
                      fontWeight: 900,
                      color: COLORS.navy,
                      marginBottom: 10,
                    }}
                  >
                    Edit Layout Notes
                  </div>

                  <textarea
                    value={layoutDraft}
                    onChange={(e) => setLayoutDraft(e.target.value)}
                    rows={4}
                    placeholder="Add layout / rules / notes players need…"
                    style={{
                      width: "100%",
                      padding: 12,
                      borderRadius: 14,
                      border: "1px solid rgba(0,0,0,0.2)",
                      fontWeight: 700,
                      resize: "vertical",
                    }}
                  />

                  <div
                    style={{
                      marginTop: 10,
                      display: "flex",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <button style={buttonStyle} onClick={adminSaveLayout}>
                      Save Layout
                    </button>
                  </div>
                </div>

                {/* Make Teams + Cards */}
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button style={buttonStyle} onClick={adminMakeTeamsAndCards}>
                    Make Teams & Cards
                  </button>

                  <button
                    style={subtleButton}
                    onClick={() => {
                      if (!requireAdmin()) return;
                      setEditStartHolesMode((v) => !v);
                    }}
                  >
                    {editStartHolesMode
                      ? "Cancel Start Hole Edit"
                      : "Edit Starting Holes"}
                  </button>

                  <button style={dangerButton} onClick={adminResetDoublesOnly}>
                    Erase Doubles (Start Fresh)
                  </button>
                </div>

                {/* Edit Starting Holes UI (requested) */}
                {editStartHolesMode ? (
                  <div
                    style={{
                      padding: 12,
                      borderRadius: 14,
                      border: "1px solid rgba(0,0,0,0.08)",
                      background: "#fff",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 900,
                        color: COLORS.navy,
                        marginBottom: 10,
                      }}
                    >
                      Edit Starting Holes
                    </div>

                    {(cards || []).length === 0 ? (
                      <div style={{ color: COLORS.gray, fontWeight: 700 }}>
                        No cards yet.
                      </div>
                    ) : (
                      <div style={{ display: "grid", gap: 10 }}>
                        {(cards || []).map((c, idx) => (
                          <div
                            key={c.id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 10,
                              padding: "10px 12px",
                              borderRadius: 14,
                              border: "1px solid rgba(0,0,0,0.08)",
                            }}
                          >
                            <div
                              style={{ fontWeight: 950, color: COLORS.navy }}
                            >
                              Card {idx + 1}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                              }}
                            >
                              <span
                                style={{ fontWeight: 900, color: COLORS.gray }}
                              >
                                Start Hole
                              </span>
                              <input
                                type="number"
                                value={startHoleEdits[c.id] ?? c.startHole ?? 1}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setStartHoleEdits((p) => ({
                                    ...p,
                                    [c.id]: val === "" ? "" : Number(val),
                                  }));
                                }}
                                style={{
                                  width: 90,
                                  padding: "10px 10px",
                                  borderRadius: 14,
                                  border: "1px solid rgba(0,0,0,0.2)",
                                  fontWeight: 900,
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div
                      style={{
                        marginTop: 12,
                        display: "flex",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <button style={buttonStyle} onClick={adminSaveStartHoles}>
                        Save Starting Holes
                      </button>
                      <button
                        style={subtleButton}
                        onClick={() => setEditStartHolesMode(false)}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Collapsible card block (like putting stations) */
function CardBlock({
  card,
  navy,
  gray,
  green,
  red,
  buttonStyle,
  subtleButton,
  getTeamParValue,
  setTeamParValue,
  submitCardScores,
  submitStatus,
}) {
  const [open, setOpen] = useState(false);

  const status = submitStatus?.[card.id] || "";
  const submitted = !!card.submittedAt;

  return (
    <div
      style={{
        borderRadius: 18,
        border: "1px solid rgba(0,0,0,0.08)",
        background: "#fff",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          cursor: "pointer",
          background: "rgba(0,0,0,0.02)",
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontWeight: 1000, color: navy }}>Card</div>
          <div style={{ fontWeight: 900, color: gray }}>
            Start Hole: {card.startHole ?? 1}
          </div>
          {submitted ? (
            <span style={{ fontWeight: 1000, color: green }}>Submitted ✅</span>
          ) : (
            <span style={{ fontWeight: 1000, color: gray }}>Not submitted</span>
          )}
        </div>

        <button
          style={subtleButton}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? "Collapse" : "Expand"}
        </button>
      </div>

      {!open ? null : (
        <div style={{ padding: 12 }}>
          <div style={{ fontWeight: 1000, color: navy, marginBottom: 8 }}>
            Teams
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            {(card.teams || []).map((t) => (
              <div
                key={t.id}
                style={{
                  padding: "10px 12px",
                  borderRadius: 14,
                  border: "1px solid rgba(0,0,0,0.08)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 1000, color: navy }}>
                      {t.teamName}
                    </div>
                    <div
                      style={{
                        marginTop: 4,
                        color: gray,
                        fontWeight: 800,
                        fontSize: 13,
                      }}
                    >
                      {Array.isArray(t.players) ? t.players.join(" + ") : ""}
                    </div>
                  </div>

                  <div
                    style={{ display: "flex", alignItems: "center", gap: 10 }}
                  >
                    <span style={{ fontWeight: 900, color: gray }}>Score</span>
                    <select
                      value={getTeamParValue(card.id, t.id)}
                      onChange={(e) =>
                        setTeamParValue(card.id, t.id, Number(e.target.value))
                      }
                      style={{
                        padding: "10px 10px",
                        borderRadius: 14,
                        border: "1px solid rgba(0,0,0,0.2)",
                        fontWeight: 900,
                      }}
                    >
                      {range(-18, 18).map((n) => (
                        <option key={n} value={n}>
                          {n === 0 ? "E" : n > 0 ? `+${n}` : `${n}`}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div
            style={{
              marginTop: 12,
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <button style={buttonStyle} onClick={() => submitCardScores(card)}>
              Submit Card
            </button>

            {status === "ok" ? (
              <span style={{ fontWeight: 1000, color: green }}>
                Submission successful ✅
              </span>
            ) : status === "err" ? (
              <span style={{ fontWeight: 1000, color: red }}>
                Submission failed ❌
              </span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
