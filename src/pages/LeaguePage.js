import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";
import { db, ensureAnonAuth } from "../firebase";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";

const ADMIN_PASSWORD = "Pescado!admin"; // 🔐 admin-only

export default function LeaguePage() {
  const navigate = useNavigate();

  const [leagueId, setLeagueId] = useState("");
  const [newLeagueId, setNewLeagueId] = useState("");
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState("");

  const COLORS = {
    navy: "#1b1f5a",
    orange: "#f4a83a",
    border: "rgba(27,31,90,0.25)",
    card: "#ffffff",
    muted: "rgba(0,0,0,0.65)",
    soft: "#f6fbff",
    red: "#b42318",
    green: "#1a7f37",
  };

  async function goToLeague() {
    const id = leagueId.trim();
    if (!id) return;
    navigate(`/league/${encodeURIComponent(id)}`);
  }

  async function createLeague() {
    const id = newLeagueId.trim();
    if (!id) return;

    const pw = window.prompt("Admin password:");
    if (pw !== ADMIN_PASSWORD) {
      alert("Wrong password.");
      return;
    }

    setCreating(true);
    setMsg("");

    try {
      await ensureAnonAuth();

      const ref = doc(db, "leagues", id);
      const snap = await getDoc(ref);

      if (snap.exists()) {
        setMsg("❌ League already exists.");
        setCreating(false);
        return;
      }

      await setDoc(ref, {
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),

        // Tags
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

        // Putting
        puttingLeague: {
          locked: false,
          finalized: false,
          stations: 1,
          rounds: 1,
          currentRound: 1,
          cardMode: "manual",
          players: [],
          cardsByRound: {},
          scores: {},
          submitted: {},
          adjustments: {},
        },

        // Doubles
        doubles: {
          started: false,
          format: "random",
          checkins: [],
          cards: [],
          submissions: {},
          leaderboard: [],
          payoutConfig: {
            enabled: true,
            buyInDollars: 5,
            leagueFeePct: 10,
          },
          payoutsPosted: {},
        },
      });

      setMsg("✅ League created successfully.");
      setNewLeagueId("");

      setTimeout(() => {
        navigate(`/league/${encodeURIComponent(id)}`);
      }, 700);
    } catch (e) {
      console.error(e);
      setMsg("❌ Failed to create league. Check console.");
    }

    setCreating(false);
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: `linear-gradient(180deg, ${COLORS.soft} 0%, #ffffff 60%)`,
        display: "flex",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 860 }}>
        <div
          style={{
            background: COLORS.card,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 16,
            padding: 20,
            boxShadow: "0 8px 22px rgba(0,0,0,0.06)",
            textAlign: "center",
          }}
        >
          <Header />

          <h2 style={{ marginTop: 12, color: COLORS.navy }}>Search League</h2>

          {/* 🔎 Search */}
          <div
            style={{
              marginTop: 18,
              textAlign: "left",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 16,
              padding: 14,
              background: COLORS.soft,
            }}
          >
            <div style={{ fontWeight: 1000, color: COLORS.navy }}>
              Go to league by ID
            </div>

            <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
              <input
                style={{
                  flex: 1,
                  padding: "14px",
                  borderRadius: 14,
                  border: `1px solid ${COLORS.border}`,
                  fontSize: 16,
                }}
                placeholder="Enter league id…"
                value={leagueId}
                onChange={(e) => setLeagueId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && goToLeague()}
              />
              <button
                style={{
                  padding: "14px 18px",
                  borderRadius: 14,
                  border: `2px solid ${COLORS.navy}`,
                  background: COLORS.navy,
                  color: "white",
                  fontWeight: 1000,
                  cursor: "pointer",
                }}
                onClick={goToLeague}
              >
                Go
              </button>
            </div>
          </div>

          {/* 🛠 Admin */}
          <div
            style={{
              marginTop: 20,
              textAlign: "left",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 16,
              padding: 14,
              background: "#f8fbff",
            }}
          >
            <div style={{ fontWeight: 1000, color: COLORS.navy }}>
              Create New League (Admin)
            </div>

            <div style={{ marginTop: 10 }}>
              <input
                style={{
                  width: "100%",
                  padding: "14px",
                  borderRadius: 14,
                  border: `1px solid ${COLORS.border}`,
                  fontSize: 16,
                }}
                placeholder="New league id (ex: pescado, winter-2026)"
                value={newLeagueId}
                onChange={(e) => setNewLeagueId(e.target.value)}
              />
            </div>

            <div
              style={{
                marginTop: 12,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <button
                onClick={createLeague}
                disabled={creating}
                style={{
                  padding: "14px 20px",
                  borderRadius: 14,
                  border: `2px solid ${COLORS.navy}`,
                  background: COLORS.orange,
                  fontWeight: 1000,
                  cursor: "pointer",
                }}
              >
                Create League
              </button>

              {msg && (
                <div
                  style={{
                    fontWeight: 900,
                    color: msg.startsWith("✅") ? COLORS.green : COLORS.red,
                  }}
                >
                  {msg}
                </div>
              )}
            </div>
          </div>

          <div style={{ marginTop: 14, fontSize: 12, opacity: 0.6 }}>
            (League IDs are not listed here by design.)
          </div>
        </div>
      </div>
    </div>
  );
}
