import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";

export default function LeaguePage() {
  const navigate = useNavigate();
  const [leagueId, setLeagueId] = useState("");

  const COLORS = {
    navy: "#1b1f5a",
    orange: "#f4a83a",
    border: "rgba(27,31,90,0.25)",
    card: "#ffffff",
    muted: "rgba(0,0,0,0.65)",
    soft: "#f6fbff",
  };

  const pageWrap = {
    minHeight: "100vh",
    background: `linear-gradient(180deg, ${COLORS.soft} 0%, #ffffff 60%)`,
    display: "flex",
    justifyContent: "center",
    padding: 24,
  };

  const container = { width: "100%", maxWidth: 860 };

  const card = {
    background: COLORS.card,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 16,
    padding: 18,
    boxShadow: "0 8px 22px rgba(0,0,0,0.06)",
    textAlign: "center",
  };

  const input = {
    width: "100%",
    padding: "14px 14px",
    borderRadius: 14,
    border: `1px solid ${COLORS.border}`,
    outline: "none",
    fontSize: 16,
  };

  const goBtn = {
    padding: "14px 18px",
    borderRadius: 14,
    border: `2px solid ${COLORS.navy}`,
    background: COLORS.navy,
    color: "white",
    fontWeight: 1000,
    cursor: "pointer",
    minWidth: 88,
  };

  function go() {
    const id = (leagueId || "").trim();
    if (!id) return;
    navigate(`/league/${encodeURIComponent(id)}`);
  }

  return (
    <div style={pageWrap}>
      <div style={container}>
        <div style={card}>
          <Header />
          <h2 style={{ marginTop: 12, color: COLORS.navy }}>League</h2>
          <div style={{ color: COLORS.muted, fontWeight: 800 }}>
            Choose a league to continue.
          </div>

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
              Go to a league by ID
            </div>
            <div style={{ fontSize: 13, color: COLORS.muted, fontWeight: 800 }}>
              Example: <b>pescado</b> or <b>default-league</b>
            </div>

            <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
              <input
                style={input}
                placeholder="Enter league id..."
                value={leagueId}
                onChange={(e) => setLeagueId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") go();
                }}
              />
              <button style={goBtn} onClick={go}>
                Go
              </button>
            </div>
          </div>

          <div style={{ marginTop: 16, fontSize: 12, opacity: 0.6 }}>
            (League IDs are not listed here by design.)
          </div>
        </div>
      </div>
    </div>
  );
}
