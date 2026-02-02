import React from "react";
import Header from "../components/Header";

export default function DoublesPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #e6f3ff 0%, #ffffff 60%)",
        display: "flex",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 760 }}>
        <div
          style={{
            textAlign: "center",
            background: "#ffffff",
            borderRadius: 18,
            padding: 26,
            border: "2px solid #1b1f5a",
            boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
          }}
        >
          {/* Shared Header (logo + Pescado Mojado) */}
          <Header />

          {/* Page Title */}
          <div
            style={{
              marginTop: 18,
              fontWeight: 900,
              fontSize: 20,
              color: "#1b1f5a",
            }}
          >
            Doubles
          </div>

          {/* Page Content */}
          <div
            style={{
              marginTop: 16,
              fontSize: 14,
              opacity: 0.8,
            }}
          >
            Doubles functionality coming soon.
          </div>
        </div>
      </div>
    </div>
  );
}
