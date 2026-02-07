// src/pages/TagsPage.js
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
  runTransaction,
} from "firebase/firestore";

const ADMIN_PASSWORD = "Pescado!";

function uid() {
  return Math.random().toString(36).substring(2, 10);
}

function nowMs() {
  return Date.now();
}

function weeksToMs(weeks) {
  return Number(weeks) * 7 * 24 * 60 * 60 * 1000;
}

function formatTimeLeft(deadlineMs) {
  const diff = Math.max(0, Number(deadlineMs || 0) - nowMs());

  // If less than 1 day, show mm:ss (better for 1-minute test)
  if (diff < 24 * 60 * 60 * 1000) {
    const totalSec = Math.ceil(diff / 1000);
    const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const ss = String(totalSec % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  // Otherwise show days
  const days = Math.ceil(diff / (24 * 60 * 60 * 1000));
  return `${days}d`;
}

/**
 * Replay rounds (scores only) from players' baseline startTag to compute current tags.
 * This is ONLY for the current leaderboard.
 */
function computeLeaderboard(players, rounds) {
  const currentTags = {};
  players.forEach((p) => (currentTags[p.id] = Number(p.startTag)));

  for (const r of rounds) {
    const participants = (r.scores || [])
      .map((s) => ({
        id: s.id,
        score: Number(s.score),
        oldTag: currentTags[s.id],
      }))
      .filter((x) => typeof x.oldTag === "number" && !Number.isNaN(x.score));

    if (participants.length < 2) continue;

    // lowest score wins
    participants.sort((a, b) => a.score - b.score);

    // lowest tag is best
    const tags = participants.map((p) => p.oldTag).sort((a, b) => a - b);

    // assign tags by finish order
    participants.forEach((p, i) => {
      currentTags[p.id] = tags[i];
    });
  }

  return players.map((p) => ({
    id: p.id,
    name: p.name,
    tag: currentTags[p.id],
  }));
}

/**
 * Given the CURRENT leaderboard tags and a score list, compute the tag swaps for THIS round.
 */
function computeRoundSwaps(currentLeaderboard, scoreList) {
  const tagById = {};
  currentLeaderboard.forEach((p) => (tagById[p.id] = p.tag));

  const participants = scoreList
    .map((s) => ({
      id: s.id,
      score: Number(s.score),
      oldTag: tagById[s.id],
    }))
    .filter((x) => typeof x.oldTag === "number" && !Number.isNaN(x.score));

  const finishOrder = [...participants].sort((a, b) => a.score - b.score);
  const tags = finishOrder.map((p) => p.oldTag).sort((a, b) => a - b);

  const nextTagMap = {};
  finishOrder.forEach((p, i) => {
    nextTagMap[p.id] = tags[i];
  });

  return { finishOrder, nextTagMap };
}

function getScopeTags(scope, sortedLeaderboard) {
  if (scope === "podium") return [1, 2, 3];
  const maxTag = sortedLeaderboard.reduce((m, p) => Math.max(m, p.tag), 0);
  const tags = [];
  for (let t = 1; t <= maxTag; t++) tags.push(t);
  return tags;
}

export default function TagsPage() {
  const { leagueId } = useParams();

  const [players, setPlayers] = useState([]); // {id, name, startTag}
  const [rounds, setRounds] = useState([]); // [{id, date, scores:[{id,score}], system?:true}]
  const [roundHistory, setRoundHistory] = useState([]); // [{id,date,entries:[...], comment?:string}]
  const [leaderboard, setLeaderboard] = useState([]);

  // Defend Mode stored in Firestore
  const [defend, setDefend] = useState({
    enabled: false,
    scope: "podium", // "podium" | "all"
    durationType: "weeks", // "weeks" | "testMinute"
    weeks: 2,
    tagExpiresAt: {}, // {"1": epochMs, "2": epochMs, ...}
  });

  // UI-only: hide/show settings area (when off: only shown after clicking Turn ON)
  const [defendUIOpen, setDefendUIOpen] = useState(false);

  // local ticker for live countdown display
  const [tick, setTick] = useState(0);

  // Round entry UI
  const [roundPlayers, setRoundPlayers] = useState([]);
  const [scores, setScores] = useState({});
  const [roundComment, setRoundComment] = useState("");

  // Add player UI
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");

  // Admin UI dropdown
  const [adminDropPlayerId, setAdminDropPlayerId] = useState("");

  // Round History UI controls
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [expandedRoundIds, setExpandedRoundIds] = useState({});
  const [historyLimit, setHistoryLimit] = useState(5);

  // ✅ Admin Tools expandable controls
  const [adminExpanded, setAdminExpanded] = useState(false);

  // ✅ Admin unlock window (device/tab specific)
  const [adminOkUntil, setAdminOkUntil] = useState(0);

  const leagueRef = useMemo(() => doc(db, "leagues", leagueId), [leagueId]);

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

  // Subscribe
  useEffect(() => {
    let unsub = () => {};

    (async () => {
      await ensureAnonAuth();

      const first = await getDoc(leagueRef);

      // If you're doing join-only leagues, this normally won't run;
      // but keeping it is safe (only runs if doc doesn't exist).
      if (!first.exists()) {
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
        });
      }

      unsub = onSnapshot(leagueRef, (snap) => {
        const data = snap.data() || {};
        const p = data.players || [];
        const r = data.rounds || [];
        const rh = data.roundHistory || [];
        const dm = data.defendMode || {
          enabled: false,
          scope: "podium",
          durationType: "weeks",
          weeks: 2,
          tagExpiresAt: {},
        };

        setPlayers(p);
        setRounds(r);
        setRoundHistory(rh);
        setDefend(dm);
        setLeaderboard(computeLeaderboard(p, r));
      });
    })().catch(console.error);

    return () => unsub();
  }, [leagueRef]);

  // live UI timer tick (for countdown display)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Keep dropdown selection valid as players change
  useEffect(() => {
    if (!adminDropPlayerId) return;
    const exists = leaderboard.some((p) => p.id === adminDropPlayerId);
    if (!exists) setAdminDropPlayerId("");
  }, [leaderboard, adminDropPlayerId]);

  const sortedLeaderboard = [...leaderboard].sort((a, b) => a.tag - b.tag);

  function getDurationMs(mode) {
    if (mode.durationType === "testMinute") return 60 * 1000;
    return weeksToMs(mode.weeks || 2);
  }

  // ✅ Admin password gate (unlocks for 10 minutes on THIS device/tab)
  async function requireAdmin(action) {
    const now = Date.now();
    if (now < adminOkUntil) {
      await action();
      return;
    }

    const pw = window.prompt("Admin password:");
    if (pw !== ADMIN_PASSWORD) {
      alert("Wrong password.");
      return;
    }

    setAdminOkUntil(now + 10 * 60 * 1000);
    await action();
  }

  async function addPlayer() {
    if (!name || !tag) return;

    const startTag = Number(tag);
    if (Number.isNaN(startTag)) {
      alert("Please enter a valid tag number.");
      return;
    }

    if (sortedLeaderboard.some((p) => p.tag === startTag)) {
      alert("That tag is already taken.");
      return;
    }

    await updateDoc(leagueRef, {
      players: [...players, { id: uid(), name, startTag }],
    });

    setName("");
    setTag("");
  }

  function toggleRoundPlayer(id) {
    setRoundPlayers((rp) =>
      rp.includes(id) ? rp.filter((x) => x !== id) : [...rp, id]
    );
  }

  async function finalizeRound() {
    if (roundPlayers.length < 2) {
      alert("Select at least 2 players.");
      return;
    }

    const scoreList = roundPlayers.map((id) => ({
      id,
      score: Number(scores[id]),
    }));

    if (scoreList.some((s) => Number.isNaN(s.score))) {
      alert("Enter all scores.");
      return;
    }

    // Compute swaps based on CURRENT leaderboard right now
    const { finishOrder, nextTagMap } = computeRoundSwaps(
      sortedLeaderboard,
      scoreList
    );

    const nameById = {};
    sortedLeaderboard.forEach((p) => (nameById[p.id] = p.name));

    const entries = finishOrder.map((p) => ({
      id: p.id,
      name: nameById[p.id] || "Unknown",
      score: p.score,
      oldTag: p.oldTag,
      newTag: nextTagMap[p.id],
    }));

    const roundId = uid();
    const date = new Date().toLocaleString();
    const trimmedComment = (roundComment || "").trim();

    // rounds array is only used for leaderboard math; keep it score-only
    const newRound = { id: roundId, date, scores: scoreList };

    // roundHistory is for display; store comment here
    const newRoundHistoryItem = {
      id: roundId,
      date,
      entries,
      comment: trimmedComment ? trimmedComment : "",
    };

    // DEFEND MODE: reset timers for tags that were IN PLAY (oldTag)
    let newDefendMode = defend;
    if (defend?.enabled) {
      const durationMs = getDurationMs(defend);
      const included = new Set(
        getScopeTags(defend.scope, sortedLeaderboard).map(String)
      );

      const oldTagsInRound = new Set(entries.map((e) => String(e.oldTag)));
      const tagExpiresAt = { ...(defend.tagExpiresAt || {}) };

      oldTagsInRound.forEach((t) => {
        if (included.has(t)) {
          tagExpiresAt[t] = nowMs() + durationMs;
        }
      });

      newDefendMode = { ...defend, tagExpiresAt };
    }

    await updateDoc(leagueRef, {
      rounds: [...rounds, newRound],
      roundHistory: [...roundHistory, newRoundHistoryItem],
      defendMode: newDefendMode,
    });

    setRoundPlayers([]);
    setScores({});
    setRoundComment("");

    // Nice UX: open history and expand the newest round
    setHistoryExpanded(true);
    setExpandedRoundIds((prev) => ({ ...prev, [roundId]: true }));
  }

  async function deleteLastRound() {
    if (!roundHistory.length) {
      alert("No user rounds to delete.");
      return;
    }

    const lastUser = roundHistory[roundHistory.length - 1];
    const ok = window.confirm(
      `Delete the last submitted round from ${lastUser.date}?\n\nThis will remove it from Round History and update everyone's tags.`
    );
    if (!ok) return;

    const newRoundHistory = roundHistory.slice(0, -1);
    const newRounds = rounds.filter((r) => r.id !== lastUser.id);

    await updateDoc(leagueRef, {
      roundHistory: newRoundHistory,
      rounds: newRounds,
    });

    setRoundPlayers([]);
    setScores({});
    setRoundComment("");

    setExpandedRoundIds((prev) => {
      const copy = { ...prev };
      delete copy[lastUser.id];
      return copy;
    });
  }

  async function dropPlayerToLast() {
    if (!sortedLeaderboard.length) {
      alert("No players yet.");
      return;
    }

    const targetId = adminDropPlayerId;
    if (!targetId) {
      alert("Select a player from the dropdown first.");
      return;
    }

    const ordered = [...sortedLeaderboard].sort((a, b) => a.tag - b.tag);

    const targetIndex = ordered.findIndex((p) => p.id === targetId);
    if (targetIndex === -1) {
      alert("Selected player not found.");
      return;
    }

    if (targetIndex === ordered.length - 1) {
      alert(
        `${ordered[targetIndex].name} is already last (#${ordered[targetIndex].tag}).`
      );
      return;
    }

    const target = ordered[targetIndex];
    const last = ordered[ordered.length - 1];

    const ok = window.confirm(
      `Drop ${target.name} (#${target.tag}) to last place (#${last.tag})?\n\nEveryone below them will move up one spot.\nRound History will NOT be changed.`
    );
    if (!ok) return;

    const affected = ordered.slice(targetIndex);
    const finishOrder = [...affected.slice(1), affected[0]];

    const sysRound = {
      id: uid(),
      date: new Date().toLocaleString(),
      system: true,
      reason: "Admin drop-to-last",
      scores: finishOrder.map((p, i) => ({
        id: p.id,
        score: i + 1,
      })),
    };

    await updateDoc(leagueRef, {
      rounds: [...rounds, sysRound],
    });

    setAdminDropPlayerId("");
  }

  async function resetAll() {
    const ok = window.confirm(
      "This will delete ALL players and ALL rounds for everyone. Continue?"
    );
    if (!ok) return;

    await updateDoc(leagueRef, {
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
    });

    setRoundPlayers([]);
    setScores({});
    setRoundComment("");
    setName("");
    setTag("");
    setAdminDropPlayerId("");
    setHistoryExpanded(false);
    setExpandedRoundIds({});
    setDefendUIOpen(false);
    setAdminExpanded(false);
  }

  // ---------------------------
  // DEFEND MODE (cleaner UX)
  // ---------------------------

  function defendSummaryText(mode) {
    const scopeLabel = mode.scope === "all" ? "All tags" : "Podium (tags 1–3)";
    const durLabel =
      mode.durationType === "testMinute"
        ? "1 minute (test)"
        : `${Number(mode.weeks || 2)} week(s)`;
    return `${scopeLabel} • ${durLabel}`;
  }

  async function activateDefendMode() {
    await requireAdmin(async () => {
      const scope = defend.scope || "podium";
      const durationType = defend.durationType || "weeks";
      const weeks = Number(defend.weeks || 2);

      const durationMs =
        durationType === "testMinute" ? 60 * 1000 : weeksToMs(weeks);

      const scopeTags = getScopeTags(scope, sortedLeaderboard);
      const deadline = nowMs() + durationMs;

      const tagExpiresAt = {};
      scopeTags.forEach((t) => (tagExpiresAt[String(t)] = deadline));

      await updateDoc(leagueRef, {
        defendMode: {
          enabled: true,
          scope,
          durationType,
          weeks,
          tagExpiresAt,
        },
      });

      setDefendUIOpen(false);
    });
  }

  async function applyDefendSettingsWhileActive() {
    await requireAdmin(async () => {
      const scope = defend.scope || "podium";
      const durationType = defend.durationType || "weeks";
      const weeks = Number(defend.weeks || 2);

      const durationMs =
        durationType === "testMinute" ? 60 * 1000 : weeksToMs(weeks);

      const scopeTags = getScopeTags(scope, sortedLeaderboard);
      const deadline = nowMs() + durationMs;

      const tagExpiresAt = { ...(defend.tagExpiresAt || {}) };
      scopeTags.forEach((t) => (tagExpiresAt[String(t)] = deadline));

      await updateDoc(leagueRef, {
        defendMode: {
          ...defend,
          enabled: true,
          scope,
          durationType,
          weeks,
          tagExpiresAt,
        },
      });

      setDefendUIOpen(false);
    });
  }

  async function turnOffDefendMode() {
    await requireAdmin(async () => {
      await updateDoc(leagueRef, {
        defendMode: {
          ...defend,
          enabled: false,
        },
      });
      setDefendUIOpen(false);
    });
  }

  // ---------------------------
  // DROP EXPIRED TAGHOLDERS (MANUAL BUTTON)
  // ---------------------------
  async function dropExpiredTagholdersToLast() {
    await requireAdmin(async () => {
      if (!defend?.enabled) {
        alert("Defend Mode is OFF.");
        return;
      }

      const scopeTags = getScopeTags(defend.scope, sortedLeaderboard).map(
        String
      );
      const expiresAt = defend.tagExpiresAt || {};

      const expiredTagNums = scopeTags.filter((t) => {
        const d = Number(expiresAt[t] || 0);
        return d > 0 && nowMs() >= d;
      });

      if (!expiredTagNums.length) {
        alert("No expired tagholders right now.");
        return;
      }

      const expiredTagSet = new Set(expiredTagNums.map(Number));
      const lbSnapshot = [...sortedLeaderboard].sort((a, b) => a.tag - b.tag);

      const expiredHolders = lbSnapshot.filter((row) =>
        expiredTagSet.has(Number(row.tag))
      );

      if (!expiredHolders.length) {
        alert("No expired tagholders right now.");
        return;
      }

      const listText = expiredHolders
        .map((p) => `#${p.tag} — ${p.name}`)
        .join("\n");

      const ok = window.confirm(
        `Drop expired tagholders to last?\n\nThe following will be moved:\n${listText}\n\nThis will preserve their current order.\nContinue?`
      );
      if (!ok) return;

      await runTransaction(db, async (tx) => {
        const snap = await tx.get(leagueRef);
        if (!snap.exists()) return;

        const data = snap.data() || {};
        const p = data.players || [];
        const r = data.rounds || [];
        const dm = data.defendMode || defend;

        if (!dm.enabled) {
          throw new Error("Defend Mode is OFF.");
        }

        const lb = computeLeaderboard(p, r).sort((a, b) => a.tag - b.tag);
        if (lb.length < 2) return;

        const scopeTags2 = getScopeTags(dm.scope || "podium", lb).map(String);
        const expiresAt2 = dm.tagExpiresAt || {};

        const expiredTagNums2 = scopeTags2.filter((t) => {
          const d = Number(expiresAt2[t] || 0);
          return d > 0 && nowMs() >= d;
        });

        if (!expiredTagNums2.length) return;

        const expiredTagSet2 = new Set(expiredTagNums2.map(Number));

        const expiredPlayers = [];
        const nonExpiredPlayers = [];
        for (const row of lb) {
          if (expiredTagSet2.has(Number(row.tag))) expiredPlayers.push(row);
          else nonExpiredPlayers.push(row);
        }

        if (!expiredPlayers.length) return;

        const desiredOrder = [...nonExpiredPlayers, ...expiredPlayers];

        const sysRound = {
          id: uid(),
          date: new Date().toLocaleString(),
          system: true,
          reason: `Defend Mode: dropped expired tagholders (${expiredTagNums2.join(
            ", "
          )})`,
          scores: desiredOrder.map((pl, i) => ({
            id: pl.id,
            score: i + 1,
          })),
        };

        const durationMs =
          (dm.durationType || "weeks") === "testMinute"
            ? 60 * 1000
            : weeksToMs(dm.weeks || 2);

        const newExpiresAt = { ...(expiresAt2 || {}) };
        const newDeadline = nowMs() + durationMs;
        expiredTagNums2.forEach((t) => {
          newExpiresAt[String(t)] = newDeadline;
        });

        tx.update(leagueRef, {
          rounds: [...r, sysRound],
          defendMode: { ...dm, tagExpiresAt: newExpiresAt },
        });
      });
    }).catch((e) => {
      const msg = String(e?.message || e);
      if (msg.includes("Defend Mode is OFF")) alert("Defend Mode is OFF.");
      else {
        console.error(e);
        alert("Could not drop expired tagholders. Check console.");
      }
    });
  }

  // Round history helpers
  const visibleHistory = [...roundHistory]
    .slice()
    .reverse()
    .slice(0, historyLimit);

  function toggleRoundExpand(id) {
    setExpandedRoundIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  // Included tags for badges
  const includedTagsSet = new Set(
    defend?.enabled
      ? getScopeTags(defend.scope, sortedLeaderboard).map(String)
      : []
  );

  // Styling helpers
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

  // how many are currently expired (for UI hint)
  const expiredCount = (() => {
    if (!defend?.enabled) return 0;
    const scopeTags = getScopeTags(defend.scope, sortedLeaderboard).map(String);
    const expiresAt = defend.tagExpiresAt || {};
    return scopeTags.filter((t) => {
      const d = Number(expiresAt[t] || 0);
      return d > 0 && nowMs() >= d;
    }).length;
  })();

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
        {/* ✅ ONE cohesive card */}
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

          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
            League: <b>{leagueId}</b> <span style={{ opacity: 0.6 }}>•</span>{" "}
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
              marginBottom: 18,
              fontWeight: 800,
            }}
          >
            Bag Tag Leaderboard
          </div>

          {/* LEADERBOARD */}
          <h3 style={{ color: COLORS.navy, marginTop: 0 }}>Leaderboard</h3>
          <ul style={{ listStyle: "none", padding: 0, marginTop: 10 }}>
            {sortedLeaderboard.map((p) => {
              const tagStr = String(p.tag);
              const showDefend = defend?.enabled && includedTagsSet.has(tagStr);
              const deadline = Number(defend?.tagExpiresAt?.[tagStr] || 0);
              const isExpired =
                showDefend && deadline > 0 && nowMs() >= deadline;

              return (
                <li
                  key={p.id}
                  style={{
                    background: COLORS.soft,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 14,
                    padding: "10px 12px",
                    marginBottom: 8,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <span style={{ fontWeight: 900, color: COLORS.navy }}>
                    #{p.tag}
                  </span>

                  <span
                    style={{ color: COLORS.text, fontWeight: 700, flex: 1 }}
                  >
                    {p.name}
                  </span>

                  {showDefend && (
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 900,
                        padding: "6px 10px",
                        borderRadius: 999,
                        border: `1px solid ${COLORS.navy}`,
                        background: isExpired ? COLORS.red : COLORS.orange,
                        color: isExpired ? "white" : "#1a1a1a",
                        whiteSpace: "nowrap",
                      }}
                      title="Defend Mode countdown (resets when this tag appears in a recorded round)"
                    >
                      {isExpired
                        ? "EXPIRED"
                        : `${formatTimeLeft(deadline)} left`}
                      <span style={{ display: "none" }}>{tick}</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          {/* RECORD ROUND */}
          <h3 style={{ color: COLORS.navy, marginTop: 22 }}>
            Record Tag Round
          </h3>

          <div style={{ textAlign: "left", maxWidth: 560, margin: "0 auto" }}>
            {sortedLeaderboard.map((p) => (
              <div
                key={p.id}
                style={{
                  padding: "8px 10px",
                  borderRadius: 12,
                  border: `1px solid ${COLORS.border}`,
                  marginBottom: 8,
                  background: "#fff",
                }}
              >
                <label
                  style={{ display: "flex", alignItems: "center", gap: 10 }}
                >
                  <input
                    type="checkbox"
                    checked={roundPlayers.includes(p.id)}
                    onChange={() => toggleRoundPlayer(p.id)}
                  />
                  <span style={{ fontWeight: 800, color: COLORS.text }}>
                    {p.name}
                  </span>
                  <span style={{ color: COLORS.navy, opacity: 0.9 }}>
                    (#{p.tag})
                  </span>
                </label>

                {roundPlayers.includes(p.id) && (
                  <div style={{ marginTop: 8 }}>
                    <input
                      type="number"
                      placeholder="Score"
                      value={scores[p.id] ?? ""}
                      onChange={(e) =>
                        setScores({ ...scores, [p.id]: e.target.value })
                      }
                      style={{ ...inputStyle, width: "100%" }}
                    />
                  </div>
                )}
              </div>
            ))}

            <div style={{ marginTop: 12 }}>
              <textarea
                placeholder="Round comment (optional)…"
                value={roundComment}
                onChange={(e) => setRoundComment(e.target.value)}
                rows={2}
                style={{
                  width: "100%",
                  padding: 12,
                  borderRadius: 14,
                  border: `1px solid ${COLORS.border}`,
                  resize: "vertical",
                  fontFamily: "Arial, sans-serif",
                  fontSize: 14,
                  background: COLORS.soft,
                }}
              />
            </div>

            <button
              onClick={finalizeRound}
              style={{ ...buttonStyle, width: "100%", marginTop: 10 }}
            >
              Finalize Round
            </button>
          </div>

          {/* ADD PLAYER */}
          <h3 style={{ color: COLORS.navy, marginTop: 26 }}>Add Player</h3>
          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              justifyContent: "center",
              marginBottom: 6,
            }}
          >
            <input
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ ...inputStyle, width: 220 }}
            />
            <input
              type="number"
              placeholder="Tag"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              style={{ ...inputStyle, width: 120 }}
            />
            <button
              onClick={addPlayer}
              style={{
                ...buttonStyle,
                background: COLORS.green,
                color: "white",
              }}
            >
              Add
            </button>
          </div>

          {/* ROUND HISTORY */}
          <hr
            style={{
              margin: "26px 0",
              border: 0,
              borderTop: `2px solid ${COLORS.border}`,
            }}
          />

          <button
            onClick={() => setHistoryExpanded((v) => !v)}
            style={{
              ...smallButtonStyle,
              background: COLORS.orange,
              border: `1px solid ${COLORS.navy}`,
            }}
          >
            {historyExpanded ? "Hide Round History" : "Show Round History"}{" "}
            {roundHistory.length ? `(${roundHistory.length})` : ""}
          </button>

          {historyExpanded && (
            <div style={{ textAlign: "left", marginTop: 14 }}>
              {roundHistory.length === 0 ? (
                <div style={{ opacity: 0.7, marginBottom: 12 }}>
                  No rounds logged yet.
                </div>
              ) : (
                <>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      alignItems: "center",
                      marginBottom: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ fontWeight: 900, color: COLORS.navy }}>
                      Round History
                    </div>

                    <div
                      style={{ display: "flex", gap: 8, alignItems: "center" }}
                    >
                      <div style={{ fontSize: 12, opacity: 0.75 }}>Show:</div>
                      <select
                        value={historyLimit}
                        onChange={(e) =>
                          setHistoryLimit(Number(e.target.value))
                        }
                        style={{
                          padding: "8px 10px",
                          borderRadius: 12,
                          border: `1px solid ${COLORS.border}`,
                          background: "#fff",
                        }}
                      >
                        <option value={5}>Last 5</option>
                        <option value={10}>Last 10</option>
                        <option value={25}>Last 25</option>
                        <option value={1000}>All</option>
                      </select>
                    </div>
                  </div>

                  {visibleHistory.map((r) => {
                    const isOpen = !!expandedRoundIds[r.id];
                    const playerCount = Array.isArray(r.entries)
                      ? r.entries.length
                      : 0;

                    return (
                      <div
                        key={r.id}
                        style={{
                          border: `1px solid ${COLORS.border}`,
                          borderRadius: 14,
                          padding: 12,
                          marginBottom: 10,
                          background: COLORS.soft,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 10,
                            cursor: "pointer",
                          }}
                          onClick={() => toggleRoundExpand(r.id)}
                        >
                          <div>
                            <strong style={{ color: COLORS.navy }}>
                              {r.date}
                            </strong>
                            <div style={{ fontSize: 12, opacity: 0.75 }}>
                              {playerCount} player{playerCount === 1 ? "" : "s"}
                            </div>
                          </div>

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleRoundExpand(r.id);
                            }}
                            style={{
                              ...smallButtonStyle,
                              background: isOpen ? COLORS.navy : COLORS.orange,
                              color: isOpen ? "white" : "#1a1a1a",
                              border: `1px solid ${COLORS.navy}`,
                            }}
                          >
                            {isOpen ? "Collapse" : "Expand"}
                          </button>
                        </div>

                        {isOpen && (
                          <>
                            {r.comment && r.comment.trim() ? (
                              <div
                                style={{
                                  marginTop: 10,
                                  padding: 10,
                                  borderRadius: 12,
                                  background: "#fff",
                                  border: `1px solid ${COLORS.border}`,
                                  fontSize: 14,
                                }}
                              >
                                <div
                                  style={{
                                    fontSize: 12,
                                    opacity: 0.75,
                                    marginBottom: 4,
                                  }}
                                >
                                  Comment
                                </div>
                                <div style={{ whiteSpace: "pre-wrap" }}>
                                  {r.comment}
                                </div>
                              </div>
                            ) : null}

                            <div style={{ fontSize: 14, marginTop: 10 }}>
                              {Array.isArray(r.entries) &&
                                r.entries.map((e) => (
                                  <div
                                    key={e.id}
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      gap: 10,
                                      padding: "8px 0",
                                      borderBottom:
                                        "1px solid rgba(0,0,0,0.06)",
                                    }}
                                  >
                                    <div style={{ flex: 1, fontWeight: 800 }}>
                                      {e.name}
                                    </div>
                                    <div
                                      style={{ width: 90, textAlign: "right" }}
                                    >
                                      score {e.score}
                                    </div>
                                    <div
                                      style={{
                                        width: 150,
                                        textAlign: "right",
                                        color: COLORS.navy,
                                      }}
                                    >
                                      #{e.oldTag} → #{e.newTag}
                                    </div>
                                  </div>
                                ))}
                            </div>

                            <div
                              style={{
                                fontSize: 12,
                                opacity: 0.7,
                                marginTop: 8,
                                textAlign: "center",
                              }}
                            >
                              (Saved at the time of the round and won’t change
                              later.)
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {/* ADMIN TOOLS */}
          <hr
            style={{
              margin: "26px 0",
              border: 0,
              borderTop: `2px solid ${COLORS.border}`,
            }}
          />

          <button
            onClick={() => setAdminExpanded((v) => !v)}
            style={{
              ...smallButtonStyle,
              background: adminExpanded ? COLORS.red : "#fff",
              color: adminExpanded ? "white" : COLORS.red,
              border: `2px solid ${COLORS.red}`,
              width: "100%",
              fontWeight: 900,
            }}
          >
            {adminExpanded ? "Hide Admin Tools" : "Show Admin Tools"}
          </button>

          {adminExpanded && (
            <div style={{ marginTop: 12 }}>
              {/* DEFEND MODE (cleaner UX) */}
              <div
                style={{
                  border: `1px solid ${COLORS.border}`,
                  background: "#fff",
                  borderRadius: 14,
                  padding: 12,
                  marginBottom: 12,
                  textAlign: "left",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <div style={{ fontWeight: 900, color: COLORS.navy }}>
                    Defend Mode{" "}
                    {defend.enabled ? (
                      <span style={{ color: COLORS.green }}>(ACTIVE)</span>
                    ) : (
                      <span style={{ opacity: 0.6 }}>(OFF)</span>
                    )}
                  </div>

                  {defend.enabled ? (
                    <button
                      onClick={() => setDefendUIOpen((v) => !v)}
                      style={{
                        ...smallButtonStyle,
                        background: COLORS.orange,
                        border: `1px solid ${COLORS.navy}`,
                      }}
                    >
                      {defendUIOpen ? "Hide Settings" : "Change Settings"}
                    </button>
                  ) : (
                    <button
                      onClick={() => setDefendUIOpen(true)}
                      style={{
                        ...smallButtonStyle,
                        background: COLORS.green,
                        color: "white",
                        border: `1px solid ${COLORS.green}`,
                      }}
                    >
                      Turn ON
                    </button>
                  )}
                </div>

                {defend.enabled && (
                  <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
                    Current settings:{" "}
                    <strong>{defendSummaryText(defend)}</strong>
                    {" • "}Expired (in scope): <strong>{expiredCount}</strong>
                  </div>
                )}

                {defendUIOpen && (
                  <div style={{ marginTop: 12 }}>
                    <div
                      style={{ fontSize: 12, opacity: 0.78, marginBottom: 10 }}
                    >
                      Timers reset when a tag is <strong>in play</strong>{" "}
                      (appears as an <strong>oldTag</strong>) in a recorded
                      round. Expired tags show as <strong>EXPIRED</strong> until
                      you manually drop them.
                    </div>

                    <div
                      style={{
                        display: "flex",
                        gap: 10,
                        flexWrap: "wrap",
                        alignItems: "center",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 900,
                          color: COLORS.navy,
                        }}
                      >
                        Scope
                      </div>
                      <select
                        value={defend.scope || "podium"}
                        onChange={(e) =>
                          setDefend({ ...defend, scope: e.target.value })
                        }
                        style={{
                          ...inputStyle,
                          width: 190,
                          background: "#fff",
                        }}
                      >
                        <option value="podium">Podium (tags 1–3)</option>
                        <option value="all">All tags</option>
                      </select>

                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 900,
                          color: COLORS.navy,
                        }}
                      >
                        Duration
                      </div>
                      <select
                        value={defend.durationType || "weeks"}
                        onChange={(e) =>
                          setDefend({ ...defend, durationType: e.target.value })
                        }
                        style={{
                          ...inputStyle,
                          width: 180,
                          background: "#fff",
                        }}
                      >
                        <option value="testMinute">1 minute (test)</option>
                        <option value="weeks">Weeks</option>
                      </select>

                      {defend.durationType === "weeks" && (
                        <>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 900,
                              color: COLORS.navy,
                            }}
                          >
                            Weeks
                          </div>
                          <input
                            type="number"
                            min={1}
                            value={defend.weeks || 2}
                            onChange={(e) =>
                              setDefend({
                                ...defend,
                                weeks: Number(e.target.value),
                              })
                            }
                            style={{ ...inputStyle, width: 90 }}
                          />
                        </>
                      )}

                      {!defend.enabled ? (
                        <>
                          <button
                            onClick={activateDefendMode}
                            style={{
                              ...smallButtonStyle,
                              background: COLORS.green,
                              color: "white",
                              border: `1px solid ${COLORS.green}`,
                            }}
                            title="Saves settings + starts timers for tags in-scope"
                          >
                            Activate Defend Mode
                          </button>

                          <button
                            onClick={() => setDefendUIOpen(false)}
                            style={{
                              ...smallButtonStyle,
                              background: "#fff",
                              border: `1px solid ${COLORS.border}`,
                            }}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={applyDefendSettingsWhileActive}
                            style={{
                              ...smallButtonStyle,
                              background: COLORS.orange,
                              border: `1px solid ${COLORS.navy}`,
                            }}
                            title="Applies settings and restarts timers for tags in-scope"
                          >
                            Apply (Restart Timers)
                          </button>

                          <button
                            onClick={turnOffDefendMode}
                            style={{
                              ...smallButtonStyle,
                              background: COLORS.red,
                              color: "white",
                              border: `1px solid ${COLORS.red}`,
                            }}
                          >
                            Turn OFF
                          </button>
                        </>
                      )}
                    </div>

                    {defend.enabled && (
                      <div
                        style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}
                      >
                        Note: “Apply (Restart Timers)” will reset included tags
                        to a fresh full timer.
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Manual drop of expired holders */}
              <div style={{ marginTop: 14 }}>
                <button
                  onClick={dropExpiredTagholdersToLast}
                  style={{
                    ...smallButtonStyle,
                    background: expiredCount ? COLORS.red : COLORS.orange,
                    color: expiredCount ? "white" : "#1a1a1a",
                    border: `1px solid ${COLORS.navy}`,
                    width: "100%",
                  }}
                  title="Drops all expired tagholders (in scope) to last, preserving their current order"
                >
                  Drop Expired Tagholders to Last
                  {defend.enabled ? ` (${expiredCount} expired)` : ""}
                </button>
              </div>

              {/* Drop Player to Last */}
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
                  Drop Player to Last
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <select
                    value={adminDropPlayerId}
                    onChange={(e) => setAdminDropPlayerId(e.target.value)}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: `1px solid ${COLORS.border}`,
                      minWidth: 240,
                      background: "#fff",
                    }}
                  >
                    <option value="">Select player…</option>
                    {sortedLeaderboard.map((p) => (
                      <option key={p.id} value={p.id}>
                        #{p.tag} — {p.name}
                      </option>
                    ))}
                  </select>

                  <button
                    onClick={() => requireAdmin(dropPlayerToLast)}
                    style={{
                      ...smallButtonStyle,
                      background: COLORS.navy,
                      color: "white",
                      border: `1px solid ${COLORS.navy}`,
                    }}
                  >
                    Drop to Last
                  </button>
                </div>
              </div>

              {/* Delete Last Round */}
              <div style={{ marginTop: 14 }}>
                <button
                  onClick={() => requireAdmin(deleteLastRound)}
                  style={{
                    ...smallButtonStyle,
                    background: COLORS.orange,
                    border: `1px solid ${COLORS.navy}`,
                    width: "100%",
                  }}
                >
                  Delete Last Round
                </button>
              </div>

              {/* Reset All */}
              <button
                onClick={() => requireAdmin(resetAll)}
                style={{
                  ...smallButtonStyle,
                  background: COLORS.red,
                  color: "white",
                  border: `1px solid ${COLORS.red}`,
                  width: "100%",
                  marginTop: 10,
                }}
              >
                Reset All Data
              </button>
            </div>
          )}
        </div>

        {/* FOOTER */}
        <div
          style={{
            marginTop: 14,
            textAlign: "center",
            fontSize: 12,
            color: "#666",
          }}
        >
          Version 1.6 Developed by Eli Morgan
        </div>
      </div>
    </div>
  );
}
