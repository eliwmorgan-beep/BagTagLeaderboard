import React from "react";
import { NavLink } from "react-router-dom";
import Header from "../components/Header";

export default function HomePage() {
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
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 160,
    background: COLORS.orange,
    color: "#1a1a1a",
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
        <Header />

        <div style={{ marginTop: 14, textAlign: "center" }}>
          <div style={{ display: "flex", justifyContent: "center", gap: 14 }}>
            <NavLink to="/tags" style={buttonStyle}>
              Tags
            </NavLink>

            <NavLink to="/putting" style={buttonStyle}>
              Putting
            </NavLink>

            {/* ✅ NEW */}
            <NavLink to="/doubles" style={buttonStyle}>
              Doubles
            </NavLink>
          </div>
        </div>
      </div>
    </div>
  );
}
