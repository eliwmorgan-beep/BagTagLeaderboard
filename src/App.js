import React, { useEffect, useMemo, useState } from "react";
import { db, ensureAnonAuth } from "./firebase";
import { doc, getDoc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";

const LEAGUE_ID = "default-league";
const ADMIN_PASSWORD = "pescado!";

function uid() {
  return Math.random().toString(36).substring(2, 10);
}

/**
 * Compute current leaderboard tags by replaying rounds from players' baseline startTag.
 * NOTE: No persistent "adjustments" are applied anymore (prevents weird future reshuffles).
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

export default function App() {
  const [players, setPlayers] = useState([]); // {id, name, startTag}
  const [rounds, setRounds] = useState([]); // {id, date, scores:[{id,score}]}
  const [leaderboard, setLeaderboard] = useState([]); // derived

  // Round entry UI
  const [roundPlayers, setRoundPlayers] = useState([]);
  const [scores, setScores] = useState({});

  // Add player UI
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");

  // Admin UI (dropdown selection for "Drop Player to Last")
  const [adminDropPlayerId, setAdminDropPlayerId] = useState("");

  const leagueRef = useMemo(() => doc(db, "leagues", LEAGUE_ID), []);

  // Subscribe to shared data
  useEffect(() => {
    let unsub = () => {};

    (async () => {
      await ensureAnonAuth();

      const first = await getDoc(leagueRef);
      if (!first.exists()) {
        await setDoc(leagueRef, { players: [], rounds: [] });
      }

      unsub = onSnapshot(leagueRef, (snap) => {
        const data = snap.data() || {};
        const p = data.players || [];
        const r = data.rounds || [];

        setPlayers(p);
        setRounds(r);
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

  async function addPlayer() {
    if (!name || !tag) return;

    const startTag = Number(tag);
    if (Number.isNaN(startTag)) {
      alert("Please enter a valid tag number.");
      return;
    }

    // Prevent duplicates vs current leaderboard tags
    if (leaderboard.some((p) => p.tag === startTag)) {
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

    const scoresList = roundPlayers.map((id) => ({
      id,
      score: Number(scores[id]),
    }));

    if (scoresList.some((s) => Number.isNaN(s.score))) {
      alert("Enter all scores.");
      return;
    }

    await updateDoc(leagueRef, {
      rounds: [
        ...rounds,
        { id: uid(), date: new Date().toLocaleString(), scores: scoresList },
      ],
    });

    setRoundPlayers([]);
    setScores({});
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
    if (!rounds.length) {
      alert("No rounds to delete.");
      return;
    }

    const last = rounds[rounds.length - 1];
    const ok = window.confirm(
      `Delete the last round from ${last.date}? This will update everyone's tags.`
    );
    if (!ok) return;

    await updateDoc(leagueRef, { rounds: rounds.slice(0, -1) });

    setRoundPlayers([]);
    setScores({});
  }

  /**
   * ADMIN: Drop a player to last (highest tag) WITHOUT deleting rounds.
   * ONE-TIME change: updates players' baseline startTag so it won't reapply later.
   */
  async function dropPlayerToLast() {
    if (!leaderboard.length) {
      alert("No players yet.");
      return;
    }

    const targetId = adminDropPlayerId;
    if (!targetId) {
      alert("Select a player from the dropdown first.");
      return;
    }

    const target = leaderboard.find((p) => p.id === targetId);
    if (!target) {
      alert("Selected player not found.");
      return;
    }

    // Find last-place (highest tag)
    let last = null;
    for (const p of leaderboard) {
      if (!last || p.tag > last.tag) last = p;
    }
    if (!last) return;

    if (last.id === target.id) {
      alert(`${target.name} is already last (#${last.tag}).`);
      return;
    }

    const ok = window.confirm(
      `Drop ${target.name} (#${target.tag}) to last place (#${last.tag})?\n\nThis will NOT delete rounds. It only changes current tag order.`
    );
    if (!ok) return;

    // Build a tag map from CURRENT tags
    const tagMap = {};
    leaderboard.forEach((p) => (tagMap[p.id] = p.tag));

    // Swap target with last to keep tags unique
    const temp = tagMap[target.id];
    tagMap[target.id] = tagMap[last.id];
    tagMap[last.id] = temp;

    // Write new baseline tags back into players.startTag
    const newPlayers = players.map((p) => ({
      ...p,
      startTag: tagMap[p.id],
    }));

    await updateDoc(leagueRef, { players: newPlayers });

    // Clear selection after action
    setAdminDropPlayerId("");
  }

  async function resetAll() {
    const ok = window.confirm(
      "This will delete ALL players and ALL rounds for everyone. Continue?"
    );
    if (!ok) return;

    await updateDoc(leagueRef, { players: [], rounds: [] });

    setRoundPlayers([]);
    setScores({});
    setName("");
    setTag("");
    setAdminDropPlayerId("");
  }

  const sortedLeaderboard = [...leaderboard].sort((a, b) => a.tag - b.tag);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#e6f3ff",
        display: "flex",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        style={{
          maxWidth: 700,
          width: "100%",
          textAlign: "center",
          background: "white",
          borderRadius: 12,
          padding: 24,
        }}
      >
        <h1 style={{ color: "#004c99", marginBottom: 4 }}>Pescado Mojado</h1>
        <div style={{ color: "#cc0000", marginBottom: 20 }}>
          Bag Tag Leaderboard
        </div>

        <h3>Leaderboard</h3>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {sortedLeaderboard.map((p) => (
            <li key={p.id}>
              <strong>#{p.tag}</strong> – {p.name}
            </li>
          ))}
        </ul>

        <h3>Create Tag Round</h3>
        {sortedLeaderboard.map((p) => (
          <div key={p.id}>
            <label>
              <input
                type="checkbox"
                checked={roundPlayers.includes(p.id)}
                onChange={() => toggleRoundPlayer(p.id)}
              />{" "}
              {p.name} (#{p.tag})
            </label>
            {roundPlayers.includes(p.id) && (
              <input
                type="number"
                placeholder="Score"
                value={scores[p.id] ?? ""}
                onChange={(e) =>
                  setScores({ ...scores, [p.id]: e.target.value })
                }
                style={{ marginLeft: 8 }}
              />
            )}
          </div>
        ))}
        <button onClick={finalizeRound} style={{ marginTop: 8 }}>
          Finalize Round
        </button>

        {/* Add Player moved to bottom above Admin Tools */}
        <h3 style={{ marginTop: 24 }}>Add Player</h3>
        <input
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="number"
          placeholder="Tag"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          style={{ marginLeft: 6 }}
        />
        <button onClick={addPlayer} style={{ marginLeft: 6 }}>
          Add
        </button>

        <hr style={{ margin: "24px 0" }} />

        <div style={{ color: "#cc0000", marginBottom: 8 }}>Admin Tools</div>

        <button
          onClick={() => adminAction(deleteLastRound)}
          style={{ margin: 4 }}
        >
          Delete Last Round
        </button>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
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
                padding: "6px 10px",
                borderRadius: 8,
                border: "1px solid #ccc",
                minWidth: 220,
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
              style={{ margin: 4 }}
            >
              Drop to Last
            </button>
          </div>
        </div>

        <button onClick={() => adminAction(resetAll)} style={{ margin: 4 }}>
          Reset All Data
        </button>
      </div>
    </div>
  );
}
