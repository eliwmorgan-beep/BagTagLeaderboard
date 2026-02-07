import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";
import { db, ensureAnonAuth } from "../firebase";
import { doc, getDoc } from "firebase/firestore";

export default function HomePage() {
  const navigate = useNavigate();

  const COLORS = {
    blueLight: "#e6f3ff",
    navy: "#1b1f5a",
    orange: "#f4a83a",
  };

  const buttonStyle = {
    padding: "14px 18px",
    borderRadius: 14,
    border: `2px solid ${COLORS.navy}`,
    fontWeight: 1000,
    cursor: "pointer",
    textDecoration: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    maxWidth: 320,
    background: COLORS.orange,
    color: "#1a1a1a",
  };

  const inputStyle = {
    padding: 12,
    borderRadius: 12,
    border: "1px solid #ccc",
    fontSize: 14,
    width: "100%",
    maxWidth: 320,
  };

  const [leagueIdInput, setLeagueIdInput] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");

  async function handleJoinLeague(e) {
    e.preventDefault();
    setJoinError("");

    const leagueId = leagueIdInput.trim();

    if (!leagueId) {
      setJoinError("Please enter a league name/code.");
      return;
    }

    setJoining(true);
    try {
      await ensureAnonAuth();

      // Join-only: league must already exist
      const leagueRef = doc(db, "leagues", leagueId);
      const snap = await getDoc(leagueRef);

      if (!snap.exists()) {
        setJoinError("League not found. Check the name/code and try again.");
        return;
      }

      navigate(`/league/${encodeURIComponent(leagueId)}`);
    } catch (err) {
      console.error(err);
      setJoinError("Could not join league. Try again.");
    } finally {
      setJoining(false);
    }
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

        <div style={{ marginTop: 18, textAlign: "center" }}>
          <h1 style={{ margin: 0 }}>Join a League</h1>
          <div style={{ marginTop: 6, opacity: 0.8, fontSize: 13 }}>
            Enter your league name/code to open that league.
          </div>

          <form
            onSubmit={handleJoinLeague}
            style={{
              marginTop: 16,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
            }}
          >
            <input
              value={leagueIdInput}
              onChange={(e) => setLeagueIdInput(e.target.value)}
              placeholder="League name/code (example: pescado)"
              style={inputStyle}
              autoFocus
            />

            {joinError && (
              <div style={{ color: "#b00020", fontSize: 13, maxWidth: 320 }}>
                {joinError}
              </div>
            )}

            <button type="submit" style={buttonStyle} disabled={joining}>
              {joining ? "Joining..." : "Open League"}
            </button>

            <div
              style={{
                marginTop: 4,
                opacity: 0.75,
                fontSize: 12,
                maxWidth: 380,
              }}
            >
              Tip: league names are case-sensitive. Try <b>pescado</b> if that’s
              your default league.
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
