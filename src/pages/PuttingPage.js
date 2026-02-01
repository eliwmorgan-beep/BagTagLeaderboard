import React from "react";
import Header from "../components/Header";

export default function PuttingPage() {
  const COLORS = {
    blueLight: "#e6f3ff",
    navy: "#1b1f5a",
    border: "#dbe9ff",
    panel: "#ffffff",
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

        <div
          style={{
            marginTop: 14,
            background: COLORS.panel,
            borderRadius: 18,
            padding: 22,
            border: `1px solid ${COLORS.border}`,
            boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
          }}
        >
          <h2 style={{ color: COLORS.navy, marginTop: 0 }}>Putting</h2>
          <div style={{ opacity: 0.75 }}>Coming next…</div>
        </div>
      </div>
    </div>
  );
}
