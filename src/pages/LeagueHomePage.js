import React, { useEffect, useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import Header from "../components/Header";

export default function LeagueHomePage() {
  const { leagueId } = useParams();

  const COLORS = {
    navy: "#1b1f5a",
    orange: "#f4a83a",
    border: "rgba(27,31,90,0.25)",
    card: "#ffffff",
    muted: "rgba(0,0,0,0.65)",
    soft: "#f6fbff",
  };

  // --- tiny responsive helper (no CSS file needed) ---
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 520px)");
    const apply = () => setIsMobile(!!mq.matches);
    apply();
    if (mq.addEventListener) mq.addEventListener("change", apply);
    else mq.addListener(apply);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", apply);
      else mq.removeListener(apply);
    };
  }, []);

  const pageWrap = {
    minHeight: "100vh",
    background: `linear-gradient(180deg, ${COLORS.soft} 0%, #ffffff 60%)`,
    display: "flex",
    justifyContent: "center",
    padding: isMobile ? 14 : 24, // ✅ smaller padding on mobile
    boxSizing: "border-box",
  };

  const container = {
    width: "100%",
    maxWidth: 860,
    boxSizing: "border-box",
  };

  const card = {
    background: COLORS.card,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 16,
    padding: isMobile ? 14 : 18,
    boxShadow: "0 8px 22px rgba(0,0,0,0.06)",
    textAlign: "center",
    boxSizing: "border-box",
    maxWidth: "100%",
    overflow: "hidden", // ✅ prevents any tiny iOS overflow artifacts
  };

  const bigBtn = {
    display: "block",
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box", // ✅ key fix for border overflow
    padding: isMobile ? "14px 14px" : "14px 16px",
    borderRadius: 14,
    border: `2px solid ${COLORS.navy}`,
    background: COLORS.orange,
    fontWeight: 1000,
    color: "#111",
    textDecoration: "none",
    cursor: "pointer",
    lineHeight: 1.2,
  };

  const bigBtnDisabled = {
    ...bigBtn,
    background: "#f7f2e6",
    color: "rgba(0,0,0,0.55)",
    border: `2px solid rgba(27,31,90,0.35)`,
  };

  const smallLink = {
    color: COLORS.navy,
    fontWeight: 900,
    textDecoration: "none",
  };

  if (!leagueId) {
    return (
      <div style={pageWrap}>
        <div style={container}>
          <div style={card}>
            <Header />
            <h2 style={{ marginTop: 12, color: COLORS.navy }}>League</h2>
            <div style={{ color: COLORS.muted, fontWeight: 800 }}>
              No league selected.
            </div>
            <div style={{ marginTop: 14 }}>
              <NavLink to="/" style={smallLink}>
                ← Back to league chooser
              </NavLink>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const enc = encodeURIComponent(leagueId);

  return (
    <div style={pageWrap}>
      <div style={container}>
        <div style={card}>
          <Header />

          <div style={{ marginTop: 8, fontSize: 13, color: COLORS.muted }}>
            League ID: <b style={{ color: COLORS.navy }}>{leagueId}</b>
          </div>

          <h2 style={{ marginTop: 16, marginBottom: 10, color: COLORS.navy }}>
            Choose a section
          </h2>

          <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
            <NavLink to={`/league/${enc}/tags`} style={bigBtn}>
              Bag Tags
            </NavLink>

            <NavLink to={`/league/${enc}/putting`} style={bigBtn}>
              Putting League
            </NavLink>

            <NavLink to={`/league/${enc}/doubles`} style={bigBtn}>
              Doubles
            </NavLink>

            {/* ✅ new module (placeholder) */}
            <NavLink
              to="#"
              onClick={(e) => {
                e.preventDefault();
                alert("Saved Leaderboards is coming soon.");
              }}
              style={bigBtnDisabled}
              title="Coming soon"
            >
              Saved Leaderboards{" "}
              <span style={{ fontSize: 12, fontWeight: 900, opacity: 0.75 }}>
                (coming soon)
              </span>
            </NavLink>
          </div>

          <div style={{ marginTop: 18 }}>
            <NavLink to="/" style={smallLink}>
              ← Back to league chooser
            </NavLink>
          </div>
        </div>

        <div
          style={{
            marginTop: 14,
            fontSize: 12,
            opacity: 0.6,
            textAlign: "center",
          }}
        >
          League hub
        </div>
      </div>
    </div>
  );
}
