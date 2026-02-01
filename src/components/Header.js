import React from "react";
import { useNavigate } from "react-router-dom";

export default function Header() {
  const navigate = useNavigate();

  const COLORS = {
    navy: "#1b1f5a",
    orange: "#f4a83a",
  };

  return (
    <button
      onClick={() => navigate("/")}
      style={{
        appearance: "none",
        WebkitAppearance: "none",
        border: "none",
        background: "transparent",
        padding: 0,
        cursor: "pointer",
        width: "100%",
        display: "block",
      }}
      aria-label="Go to Home"
      title="Go to Home"
    >
      <div style={{ textAlign: "center" }}>
        <img
          src="/pescado-logo.png"
          alt="Pescado Mojado logo"
          style={{
            width: 140,
            height: 140,
            objectFit: "contain",
            borderRadius: 999,
            border: `4px solid ${COLORS.orange}`,
            boxShadow: "0 8px 22px rgba(0,0,0,0.10)",
            marginBottom: 12,
          }}
        />

        <h1 style={{ color: COLORS.navy, margin: 0, lineHeight: 1.1 }}>
          Pescado Mojado
        </h1>
      </div>
    </button>
  );
}
