import React, { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
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

  // Modal state
  const [showLeagueDialog, setShowLeagueDialog] = useState(false);
  const [leagueIdInput, setLeagueIdInput] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");

  function openLeagueDialog() {
    setJoinError("");
    setLeagueIdInput("");
    setShowLeagueDialog(true);
  }

  function closeLeagueDialog() {
    setShowLeagueDialog(false);
  }

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

      // Look up the league doc
      const leagueRef = doc(db, "leagues", leagueId);
      const snap = await getDoc(leagueRef);

      if (!snap.exists()) {
        setJoinError("League not found. Check the name/code and try again.");
        return;
      }

      // Success -> go to league page
      setShowLeagueDialog(false);
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

        <div style={{ marginTop: 14, textAlign: "center" }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 14,
            }}
          >
            <NavLink to="/tags" style={buttonStyle}>
              Tags
            </NavLink>

            <NavLink to="/putting" style={buttonStyle}>
              Putting
            </NavLink>

            <NavLink to="/doubles" style={buttonStyle}>
              Doubles
            </NavLink>

            {/* League button opens modal */}
            <button
              type="button"
              style={buttonStyle}
              onClick={openLeagueDialog}
            >
              League
            </button>
          </div>
        </div>

        {/* Modal */}
        {showLeagueDialog && (
          <div
            onClick={closeLeagueDialog}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              zIndex: 9999,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                maxWidth: 420,
                background: "#fff",
                borderRadius: 16,
                border: `2px solid ${COLORS.navy}`,
                padding: 16,
                boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
              }}
            >
              <div style={{ fontWeight: 1000, fontSize: 18 }}>
                Join a League
              </div>
              <div style={{ marginTop: 6, opacity: 0.8, fontSize: 13 }}>
                Enter the league name/code you were given.
              </div>

              <form onSubmit={handleJoinLeague} style={{ marginTop: 14 }}>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 10 }}
                >
                  <input
                    value={leagueIdInput}
                    onChange={(e) => setLeagueIdInput(e.target.value)}
                    placeholder="League name/code (example: default-league)"
                    style={{
                      padding: 12,
                      borderRadius: 12,
                      border: "1px solid #ccc",
                      fontSize: 14,
                    }}
                    autoFocus
                  />

                  {joinError && (
                    <div style={{ color: "#b00020", fontSize: 13 }}>
                      {joinError}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
                    <button
                      type="button"
                      onClick={closeLeagueDialog}
                      style={{
                        flex: 1,
                        padding: 12,
                        borderRadius: 12,
                        border: `2px solid ${COLORS.navy}`,
                        background: "#fff",
                        fontWeight: 900,
                        cursor: "pointer",
                      }}
                      disabled={joining}
                    >
                      Cancel
                    </button>

                    <button
                      type="submit"
                      style={{
                        flex: 1,
                        padding: 12,
                        borderRadius: 12,
                        border: `2px solid ${COLORS.navy}`,
                        background: COLORS.orange,
                        fontWeight: 900,
                        cursor: "pointer",
                      }}
                      disabled={joining}
                    >
                      {joining ? "Joining..." : "Join"}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
