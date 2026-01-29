import React, { useEffect, useMemo, useState } from "react";
import { db, ensureAnonAuth } from "./firebase";
import { doc, getDoc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";

const LEAGUE_ID = "default-league";
const ADMIN_PASSWORD = "ChangeThisToYourOwnPassword123!";

function uid() {
  return Math.random().toString(36).substring(2, 10);
}

function computeDerived(players, rounds, adjustments) {
  const currentTags = {};
  players.forEach((p) => (currentTags[p.id] = Number(p.startTag)));

  const history = {};
  players.forEach((p) => (history[p.id] = []));

  for (const r of rounds) {
    const participants = (r.scores || [])
      .map((s) => ({
        id: s.id,
        score: Number(s.score),
        oldTag: currentTags[s.id],
      }))
      .filter((x) => typeof x.oldTag === "number" && !Number.isNaN(x.score));

    if (participants.length < 2) continue;

    participants.sort((a, b) => a.score - b.score);
    const tags = participants.map((p) => p.oldTag).sort((a, b) => a - b);

    participants.forEach((p, i) => {
      currentTags[p.id] = tags[i];
      history[p.id].push({
        roundId: r.id,
        date: r.date,
        oldTag: p.oldTag,
        newTag: tags[i],
        score: p.score,
      });
    });
  }

  const adj = Array.isArray(adjustments) ? adjustments : [];
  for (const a of adj) {
    if (a.type !== "dropToLast") continue;
    const pid = a.playerId;

    let maxTag = -Infinity;
    let maxId = null;

    for (const [id, tag] of Object.entries(currentTags)) {
      if (tag > maxTag) {
        maxTag = tag;
        maxId = id;
      }
    }

    if (pid in currentTags && maxId && pid !== maxId) {
      const temp = currentTags[pid];
      currentTags[pid] = currentTags[maxId];
      currentTags[maxId] = temp;
    }
  }

  return {
    leaderboard: players.map((p) => ({
      id: p.id,
      name: p.name,
      tag: currentTags[p.id],
    })),
    history,
  };
}

export default function App() {
  const [players, setPlayers] = useState([]);
  const [rounds, setRounds] = useState([]);
  const [adjustments, setAdjustments] = useState([]);

  const [leaderboard, setLeaderboard] = useState([]);
  const [history, setHistory] = useState({});

  const [roundPlayers, setRoundPlayers] = useState([]);
  const [scores, setScores] = useState({});

  const [name, setName] = useState("");
  const [tag, setTag] = useState("");

  const leagueRef = useMemo(() => doc(db, "leagues", LEAGUE_ID), []);

  useEffect(() => {
    let unsub = () => {};

    (async () => {
      await ensureAnonAuth();
      const first = await getDoc(leagueRef);
      if (!first.exists()) {
        await setDoc(leagueRef, {
          players: [],
          rounds: [],
          adjustments: [],
        });
      }

      unsub = onSnapshot(leagueRef, (snap) => {
        const data = snap.data() || {};
        setPlayers(data.players || []);
        setRounds(data.rounds || []);
        setAdjustments(data.adjustments || []);

        const derived = computeDerived(
          data.players || [],
          data.rounds || [],
          data.adjustments || []
        );
        setLeaderboard(derived.leaderboard);
        setHistory(derived.history);
      });
    })();

    return () => unsub();
  }, [leagueRef]);

  async function addPlayer() {
    if (!name || !tag) return;
    const startTag = Number(tag);
    if (leaderboard.some((p) => p.tag === startTag)) return;

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
    if (roundPlayers.length < 2) return;

    const scoresList = roundPlayers.map((id) => ({
      id,
      score: Number(scores[id]),
    }));

    if (scoresList.some((s) => Number.isNaN(s.score))) return;

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
    if (pw !== ADMIN_PASSWORD) return;
    await action();
  }

  async function deleteLastRound() {
    if (!rounds.length) return;
    await updateDoc(leagueRef, { rounds: rounds.slice(0, -1) });
  }

  async function dropPlayerToLast() {
    const tagNum = Number(
      window.prompt("Enter CURRENT tag number to drop to last:")
    );
    const player = leaderboard.find((p) => p.tag === tagNum);
    if (!player) return;

    await updateDoc(leagueRef, {
      adjustments: [
        ...adjustments,
        { id: uid(), type: "dropToLast", playerId: player.id },
      ],
    });
  }

  async function resetAll() {
    await updateDoc(leagueRef, { players: [], rounds: [], adjustments: [] });
  }

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
        <h1 style={{ color: "#004c99", marginBottom: 4 }}>
          Pescado Mojado
        </h1>
        <div style={{ color: "#cc0000", marginBottom: 20 }}>
          Bag Tag Leaderboard
        </div>

        <h3>Leaderboard</h3>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {[...leaderboard]
            .sort((a, b) => a.tag - b.tag)
            .map((p) => (
              <li key={p.id}>
                <strong>#{p.tag}</strong> – {p.name}
              </li>
            ))}
        </ul>

        <h3>Create Tag Round</h3>
        {leaderboard.map((p) => (
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

        {/* ADD PLAYER MOVED HERE */}
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

        <div style={{ color: "#cc0000", marginBottom: 8 }}>
          Admin Tools
        </div>

        <button onClick={() => adminAction(deleteLastRound)} style={{ margin: 4 }}>
          Delete Last Round
        </button>
        <button
          onClick={() => adminAction(dropPlayerToLast)}
          style={{ margin: 4 }}
        >
          Drop Player to Last
        </button>
        <button onClick={() => adminAction(resetAll)} style={{ margin: 4 }}>
          Reset All Data
        </button>
      </div>
    </div>
  );
}