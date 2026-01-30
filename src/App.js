import React, { useEffect, useMemo, useState } from "react";
import { db, ensureAnonAuth } from "./firebase";
import { doc, getDoc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";

const LEAGUE_ID = "default-league";
const ADMIN_PASSWORD = "Pescado!";

function uid() {
  return Math.random().toString(36).substring(2, 10);
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

export default function App() {
  const [players, setPlayers] = useState([]); // {id, name, startTag}
  const [rounds, setRounds] = useState([]); // [{id, date, scores:[{id,score}], system?:true}]
  const [roundHistory, setRoundHistory] = useState([]); // [{id,date,entries:[...], comment?:string}]

  const [leaderboard, setLeaderboard] = useState([]);

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

  const leagueRef = useMemo(() => doc(db, "leagues", LEAGUE_ID), []);

  // --- Color palette pulled from your logo vibe ---
  const COLORS = {
    navy: "#1b1f5a", // dark outer ring vibe
    blue: "#0ea5e9", // splash blue
    blueLight: "#e6f3ff", // background wash
    orange: "#f4a83a", // ring orange
    green: "#15803d", // ring green
    red: "#cc0000", // accent red (mouth / splash)
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
      if (!first.exists()) {
        await setDoc(leagueRef, { players: [], rounds: [], roundHistory: [] });
      }

      unsub = onSnapshot(leagueRef, (snap) => {
        const data = snap.data() || {};
        const p = data.players || [];
        const r = data.rounds || [];
        const rh = data.roundHistory || [];

        setPlayers(p);
        setRounds(r);
        setRoundHistory(rh);

        setLeaderboard(computeLeaderboard(p, r));
      });
    })().catch(console.error);

    return () => unsub();
  }, [leagueRef]);

  // Keep dropdown selection valid as players change
  useEffect(() => {
    if (!adminDropPlayerId) return;
    const exists = leaderboard.some((p) => p.id === adminDropPlayerId);
    if (!exists) setAdminDropPlayerId("");
  }, [leaderboard, adminDropPlayerId]);

  const sortedLeaderboard = [...leaderboard].sort((a, b) => a.tag - b.tag);

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

    const newRound = { id: roundId, date, scores: scoreList };
    const newRoundHistoryItem = {
      id: roundId,
      date,
      entries,
      comment: trimmedComment ? trimmedComment : "",
    };

    await updateDoc(leagueRef, {
      rounds: [...rounds, newRound],
      roundHistory: [...roundHistory, newRoundHistoryItem],
    });

    setRoundPlayers([]);
    setScores({});
    setRoundComment("");

    setHistoryExpanded(true);
    setExpandedRoundIds((prev) => ({ ...prev, [roundId]: true }));
  }

  async function adminAction(action) {
    const pw = window.prompt("Admin password:");
    if (pw !== ADMIN_PASSWORD) {
      alert("Wrong password.");
      return;
    }
    await action();
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

    await updateDoc(leagueRef, { players: [], rounds: [], roundHistory: [] });

    setRoundPlayers([]);
    setScores({});
    setRoundComment("");
    setName("");
    setTag("");
    setAdminDropPlayerId("");
    setHistoryExpanded(false);
    setExpandedRoundIds({});
  }

  const visibleHistory = [...roundHistory]
    .slice()
    .reverse()
    .slice(0, historyLimit);

  function toggleRoundExpand(id) {
    setExpandedRoundIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }

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
    fontWeight: 700,
    cursor: "pointer",
  };

  const smallButtonStyle = {
    ...buttonStyle,
    padding: "8px 12px",
    fontWeight: 700,
  };

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
          {/* LOGO */}
          <img
            src="/pescado-logo.png"
            alt="Pescado Mojado logo"
            style={{
              width: 140,
              height: 140,
              objectFit: "contain",
              borderRadius: 999,
              border: `4px solid ${COLORS.orange}`,
              boxShadow: "0 8px 22px rgba(0,0,0,0.10)",
              marginBottom: 12,
            }}
          />

          <h1 style={{ color: COLORS.navy, marginBottom: 4 }}>
            Pescado Mojado
          </h1>
          <div style={{ color: COLORS.green, marginBottom: 18, fontWeight: 700 }}>
            Bag Tag Leaderboard
          </div>

          {/* LEADERBOARD */}
          <h3 style={{ color: COLORS.navy, marginTop: 0 }}>Leaderboard</h3>
          <ul style={{ listStyle: "none", padding: 0, marginTop: 10 }}>
            {sortedLeaderboard.map((p) => (
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
                }}
              >
                <span style={{ fontWeight: 800, color: COLORS.navy }}>
                  #{p.tag}
                </span>
                <span style={{ color: COLORS.text, fontWeight: 600 }}>
                  {p.name}
                </span>
              </li>
            ))}
          </ul>

          {/* RECORD ROUND */}
          <h3 style={{ color: COLORS.navy, marginTop: 22 }}>Record Tag Round</h3>

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
                <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input
                    type="checkbox"
                    checked={roundPlayers.includes(p.id)}
                    onChange={() => toggleRoundPlayer(p.id)}
                  />
                  <span style={{ fontWeight: 700, color: COLORS.text }}>
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

            <button onClick={finalizeRound} style={{ ...buttonStyle, width: "100%", marginTop: 10 }}>
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
            <button onClick={addPlayer} style={{ ...buttonStyle, background: COLORS.green, color: "white" }}>
              Add
            </button>
          </div>

          {/* ROUND HISTORY */}
          <hr style={{ margin: "26px 0", border: 0, borderTop: `2px solid ${COLORS.border}` }} />

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
                    <div style={{ fontWeight: 800, color: COLORS.navy }}>
                      Round History
                    </div>

                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>Show:</div>
                      <select
                        value={historyLimit}
                        onChange={(e) => setHistoryLimit(Number(e.target.value))}
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
                    const playerCount = Array.isArray(r.entries) ? r.entries.length : 0;

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
                            <strong style={{ color: COLORS.navy }}>{r.date}</strong>
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
                                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 4 }}>
                                  Comment
                                </div>
                                <div style={{ whiteSpace: "pre-wrap" }}>{r.comment}</div>
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
                                      borderBottom: "1px solid rgba(0,0,0,0.06)",
                                    }}
                                  >
                                    <div style={{ flex: 1, fontWeight: 700 }}>
                                      {e.name}
                                    </div>
                                    <div style={{ width: 90, textAlign: "right" }}>
                                      score {e.score}
                                    </div>
                                    <div style={{ width: 150, textAlign: "right", color: COLORS.navy }}>
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
                              (Saved at the time of the round and won’t change later.)
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
          <hr style={{ margin: "26px 0", border: 0, borderTop: `2px solid ${COLORS.border}` }} />
          <div style={{ color: COLORS.red, marginBottom: 8, fontWeight: 800 }}>
            Admin Tools
          </div>

          <button onClick={() => adminAction(deleteLastRound)} style={{ ...smallButtonStyle, background: COLORS.orange, border: `1px solid ${COLORS.navy}` }}>
            Delete Last Round
          </button>

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
                onClick={() => adminAction(dropPlayerToLast)}
                style={{ ...smallButtonStyle, background: COLORS.navy, color: "white", border: `1px solid ${COLORS.navy}` }}
              >
                Drop to Last
              </button>
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <button
              onClick={() => adminAction(resetAll)}
              style={{ ...smallButtonStyle, background: COLORS.red, color: "white", border: `1px solid ${COLORS.red}` }}
            >
              Reset All Data
            </button>
          </div>
        </div>

        {/* FOOTER */}
        <div
          style={{
            marginTop: 14,
            textAlign: "center",
            fontSize: 12,
            color: "rgba(27,31,90,0.70)",
          }}
        >
          Version 1.3.1 Developed by Eli Morgan
        </div>
      </div>
    </div>
  );
}
