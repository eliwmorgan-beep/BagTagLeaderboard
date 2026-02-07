// src/pages/LeaguePage.js
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";
import { db, ensureAnonAuth } from "../firebase";
import { collection, onSnapshot } from "firebase/firestore";

export default function LeaguePage() {
  const navigate = useNavigate();

  const COLORS = useMemo(
    () => ({
      navy: "#1b1f5a",
      blueLight: "#e6f3ff",
      orange: "#f4a83a",
      green: "#15803d",
      red: "#b42318",
      border: "rgba(27,31,90,0.22)",
      card: "#ffffff",
      soft: "#f6fbff",
      muted: "rgba(0,0,0,0.65)",
    }),
    []
  );

  const [loading, setLoading] = useState(true);
  const [leagueIds, setLeagueIds] = useState([]);
  const [err, setErr] = useState("");
  const [manualId, setManualId] = useState("");

  useEffect(() => {
    let unsub = () => {};

    (async () => {
      setErr("");
      setLoading(true);

      // Make sure auth is ready (your rules require request.auth != null for writes;
      // reads are allowed for everyone, but we still keep auth consistent across app)
      await ensureAnonAuth();

      const colRef = collection(db, "leagues");

      unsub = onSnapshot(
        colRef,
        (snap) => {
          const ids = snap.docs
            .map((d) => d.id)
            .sort((a, b) => a.localeCompare(b));
          setLeagueIds(ids);
          setLoading(false);
        },
        (e) => {
          console.error(e);
          setErr(
            "Could not load leagues from Firestore. (Check Firestore rules + console.)"
          );
          setLeagueIds([]);
          setLoading(false);
        }
      );
    })().catch((e) => {
      console.error(e);
      setErr(
        "Could not initialize league chooser. (Check Firestore config + console.)"
      );
      setLoading(false);
    });

    return () => unsub();
  }, []);

  function goToLeague(id) {
    const clean = String(id || "").trim();
    if (!clean) return;
    navigate(`/league/${encodeURIComponent(clean)}`);
  }

  const cardStyle = {
    background: COLORS.card,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 18,
    padding: 18,
    boxShadow: "0 10px 26px rgba(0,0,0,0.06)",
  };

  const buttonStyle = (variant = "orange") => {
    const bg =
      variant === "green"
        ? COLORS.green
        : variant === "navy"
        ? COLORS.navy
        : COLORS.orange;

    const color = variant === "green" || variant === "navy" ? "white" : "#111";

    return {
      padding: "12px 14px",
      borderRadius: 14,
      border: `2px solid ${variant === "orange" ? COLORS.navy : bg}`,
      background: bg,
      color,
      fontWeight: 1000,
      cursor: "pointer",
    };
  };

  const inputStyle = {
    padding: "12px 12px",
    borderRadius: 14,
    border: `1px solid ${COLORS.border}`,
    outline: "none",
    width: "100%",
    fontSize: 14,
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
      <div style={{ width: "100%", maxWidth: 860 }}>
        <div style={{ ...cardStyle, textAlign: "center" }}>
          <Header />

          <div
            style={{
              marginTop: 16,
              fontSize: 46,
              fontWeight: 900,
              color: COLORS.navy,
              fontFamily: "Georgia, serif",
              lineHeight: 1.1,
            }}
          >
            League
          </div>

          <div style={{ marginTop: 6, color: COLORS.muted, fontWeight: 800 }}>
            Choose a league to continue.
          </div>

          {/* Manual always-works navigation */}
          <div
            style={{
              marginTop: 18,
              padding: 14,
              borderRadius: 16,
              border: `1px solid ${COLORS.border}`,
              background: COLORS.soft,
              textAlign: "left",
            }}
          >
            <div style={{ fontWeight: 1000, color: COLORS.navy }}>
              Go to a league by ID
            </div>
            <div style={{ fontSize: 12, color: COLORS.muted, fontWeight: 800 }}>
              Example: <b>pescado</b> or <b>default-league</b>
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <input
                style={inputStyle}
                placeholder="Enter league id…"
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") goToLeague(manualId);
                }}
              />
              <button
                style={buttonStyle("navy")}
                onClick={() => goToLeague(manualId)}
              >
                Go
              </button>
            </div>
          </div>

          {/* Firestore list */}
          <div style={{ marginTop: 18, textAlign: "left" }}>
            <div style={{ fontWeight: 1000, color: COLORS.navy }}>
              Available leagues
            </div>

            {loading ? (
              <div style={{ marginTop: 10, color: COLORS.muted }}>
                Loading leagues…
              </div>
            ) : err ? (
              <div
                style={{
                  marginTop: 10,
                  padding: 12,
                  borderRadius: 14,
                  border: `1px solid rgba(180,35,24,0.35)`,
                  background: "rgba(180,35,24,0.06)",
                  color: COLORS.red,
                  fontWeight: 900,
                }}
              >
                {err}
              </div>
            ) : leagueIds.length === 0 ? (
              <div style={{ marginTop: 10, color: COLORS.muted }}>
                No leagues found in Firestore collection <b>leagues</b>.
              </div>
            ) : (
              <div
                style={{
                  marginTop: 10,
                  display: "grid",
                  gap: 10,
                  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                }}
              >
                {leagueIds.map((id) => (
                  <div
                    key={id}
                    style={{
                      border: `1px solid ${COLORS.border}`,
                      borderRadius: 16,
                      padding: 14,
                      background: "#fff",
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    <div style={{ fontWeight: 1000, color: COLORS.navy }}>
                      {id}
                    </div>

                    <button
                      style={buttonStyle("orange")}
                      onClick={() => goToLeague(id)}
                    >
                      Open
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginTop: 18, fontSize: 12, opacity: 0.7 }}>
            Tip: If this list is empty but you can see docs in Firestore, open
            your browser console—any permission/config error will show there.
          </div>
        </div>

        <div
          style={{
            marginTop: 14,
            textAlign: "center",
            fontSize: 12,
            color: "#666",
          }}
        >
          League chooser
        </div>
      </div>
    </div>
  );
}
