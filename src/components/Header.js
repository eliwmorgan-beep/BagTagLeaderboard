// src/components/Header.js
import React from "react";
import { Link } from "react-router-dom";

export default function Header() {
  const COLORS = {
    navy: "#1b1f5a",
    orange: "#f4a83a",
  };

  return (
    <Link
      to="/"
      style={{
        textDecoration: "none",
        display: "block",
        width: "100%",
      }}
      aria-label="Go to Home"
      title="Go to Home"
    >
      <div
        style={{
          textAlign: "center",
          cursor: "pointer",
        }}
      >
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
    </Link>
  );
}
