import React, { useEffect, useMemo, useState } from "react";
import { db, ensureAnonAuth } from "./firebase";
import { doc, getDoc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";

const LEAGUE_ID = "default-league";

function uid() {
  return Math.random().toString(36).substring(2, 10);
}

export default function App() {
  const [players, setPlayers] = useState([]);
  const [roundPlayers, setRoundPlayers] = useState([]);
  const [scores, setScores] = useState({});
  const [history, setHistory] = useState({});
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");

  const leagueRef = useMemo(() => doc(db, "leagues", LEAGUE_ID), []);

  // Initialize Firestore doc, then subscribe (CodeSandbox-safe)
  useEffect(() => {
    let unsub = () => {};

    (async () => {
      await ensureAnonAuth();

      const first = await getDoc(leagueRef);
      if (!first.exists()) {
        await setDoc(leagueRef, { players: [], history: {} });
      }

      unsub = onSnapshot(leagueRef, (snap) => {
        const data = snap.data() || {};
        setPlayers(data.players || []);
        setHistory(data.history || {});
      });
    })().catch(console.error);

    return () => unsub();
  }, [leagueRef]);

  async function addPlayer() {
    if (!name || !tag) return;

    const tagNum = Number(tag);
    if (players.some((p) => p.tag === tagNum)) {
      alert("That tag is already taken");
      return;
    }

    const id = uid();
    await updateDoc(leagueRef, {
      players: [...players, { id, name, tag: tagNum }],
      history: { ...history, [id]: [] },
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
      alert("Select at least 2 players");
      return;
    }

    const participants = roundPlayers.map((id) => ({
      ...players.find((p) => p.id === id),
      score: Number(scores[id]),
    }));

    if (participants.some((p) => Number.isNaN(p.score))) {
      alert("Enter all scores");
      return;
    }

    participants.sort((a, b) => a.score - b.score);
    const tags = participants.map((p) => p.tag).sort((a, b) => a - b);

    const updatedPlayers = players.map((p) => {
      const idx = participants.findIndex((pp) => pp.id === p.id);
      return idx === -1 ? p : { ...p, tag: tags[idx] };
    });

    const newHistory = { ...history };
    participants.forEach((p, i) => {
      newHistory[p.id] = [
        ...(newHistory[p.id] || []),
        {
          date: new Date().toLocaleString(),
          oldTag: p.tag,
          newTag: tags[i],
          score: p.score,
        },
      ];
    });

    await updateDoc(leagueRef, {
      players: updatedPlayers,
      history: newHistory,
    });

    setRoundPlayers([]);
    setScores({});
  }

  return (
    <div style={{ padding: 20, fontFamily: "Arial, sans-serif" }}>
      <h2>Bag Tag Tracker (Shared)</h2>

      <h3>Add Player</h3>
      <input
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        placeholder="Tag"
        type="number"
        value={tag}
        onChange={(e) => setTag(e.target.value)}
        style={{ marginLeft: 8 }}
      />
      <button onClick={addPlayer} style={{ marginLeft: 8 }}>
        Add
      </button>

      <h3>Leaderboard</h3>
      <ul>
        {[...players]
          .sort((a, b) => a.tag - b.tag)
          .map((p) => (
            <li key={p.id}>
              #{p.tag} – {p.name}
            </li>
          ))}
      </ul>

      <h3>Create Tag Round</h3>
      {players.map((p) => (
        <div key={p.id} style={{ marginBottom: 6 }}>
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
              placeholder="Score"
              type="number"
              value={scores[p.id] ?? ""}
              onChange={(e) => setScores({ ...scores, [p.id]: e.target.value })}
              style={{ marginLeft: 10 }}
            />
          )}
        </div>
      ))}
      <button onClick={finalizeRound}>Finalize Round</button>

      <h3>Player History</h3>
      {players.map((p) => (
        <div key={p.id}>
          <strong>{p.name}</strong>
          <ul>
            {(history[p.id] || []).map((h, i) => (
              <li key={i}>
                {h.date}: #{h.oldTag} → #{h.newTag} (score {h.score})
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
