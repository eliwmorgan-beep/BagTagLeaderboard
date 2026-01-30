import React, { useEffect, useMemo, useState } from "react";
import { db, ensureAnonAuth } from "./firebase";
import { doc, getDoc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";

const LEAGUE_ID = "default-league";
const ADMIN_PASSWORD = "pescado!";

function uid() {
  return Math.random().toString(36).substring(2, 10);
}

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

    participants.sort((a, b) => a.score - b.score);
    const tags = participants.map((p) => p.oldTag).sort((a, b) => a - b);

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
  const [players, setPlayers] = useState([]);
  const [rounds, setRounds] = useState([]);
  const [roundHistory, setRoundHistory] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);

  const [roundPlayers, setRoundPlayers] = useState([]);
  const [scores, setScores] = useState({});
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");

  const [adminDropPlayerId, setAdminDropPlayerId] = useState("");

  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [expandedRoundIds, setExpandedRoundIds] = useState({});
  const [historyLimit, setHistoryLimit] = useState(5);

  const leagueRef = useMemo(() => doc(db, "leagues", LEAGUE_ID), []);

  useEffect(() => {
    let unsub = () => {};

    (async () => {
      await ensureAnonAuth();
      const first = await getDoc(leagueRef);
      if (!first.exists()) {
        await setDoc(leagueRef, { players: [], rounds: [], roundHistory: [] });
      }

      unsub = onSnapshot(leagueRef, (snap) => {
        const d = snap.data() || {};
        setPlayers(d.players || []);
        setRounds(d.rounds || []);
        setRoundHistory(d.roundHistory || []);
        setLeaderboard(computeLeaderboard(d.players || [], d.rounds || []));
      });
    })();

    return () => unsub();
  }, [leagueRef]);

  const sortedLeaderboard = [...leaderboard].sort((a, b) => a.tag - b.tag);

  async function adminAction(fn) {
    const pw = window.prompt("Admin password:");
    if (pw !== ADMIN_PASSWORD) return alert("Wrong password.");
    await fn();
  }

  // --- UI OMITTED FOR BREVITY ---
  // (This section is unchanged from your current working version)
  // Everything remains exactly the same as before

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#e6f3ff",
        display: "flex",
        justifyContent: "center",
        padding: 20,
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {/* MAIN CARD */}
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
        {/* ALL EXISTING UI CONTENT STAYS HERE */}
      </div>

      {/* FOOTER */}
      <div
        style={{
          marginTop: 16,
          fontSize: 12,
          color: "#666",
          textAlign: "center",
        }}
      >
        Version 1.1 · Developed by Eli Morgan
      </div>
    </div>
  );
}
