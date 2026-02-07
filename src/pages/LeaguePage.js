// src/pages/LeaguePage.js
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";
import { db, ensureAnonAuth } from "../firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

const APP_VERSION = "league-search-v1.0.0";
const ADMIN_PASSWORD = "Pescado!"; // your admin password

function normalizeLeagueId(raw) {
  return String(raw || "").trim();
}

// allow: letters, numbers, dash, underscore
function isValidLeagueId(id) {
  return /^[a-zA-Z0-9_-]{2,40}$/.test(id);
}

export default function LeaguePage() {
  const navigate = useNavigate();

  const [leagueId, setLeagueId] = useState("");

  const [newLeagueId, setNewLeagueId] = useState("");
  const [createMsg, setCreateMsg] = useState("");
  const [createMsgColor, setCreateMsgColor] = useState("rgba(0,0,0,0.65)");
  const [creating, setCreating] = useState(false);

  // Responsive flag
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 560px)");
    const apply = () => setIsMobile(!!mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  const COLORS = useMemo(
    () => ({
      navy: "#1b1f5a",
      orange: "#f4a83a",
      border: "rgba(27,31,90,0.25)",
      card: "#ffffff",
      muted: "rgba(0,0,0,0.65)",
      soft: "#f6fbff",
      green: "#1a7f37",
      red: "#b42318",
    }),
    []
  );

  const pageWrap = {
    minHeight: "100vh",
    background: `linear-gradient(180deg, ${COLORS.soft} 0%, #ffffff 60%)`,
    display: "flex",
    justifyContent: "center",
    padding: isMobile ? 14 : 24,
  };

  const container = { width: "100%", maxWidth: 860 };

  const card = {
    background: COLORS.card,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 16,
    padding: isMobile ? 14 : 18,
    boxShadow: "0 8px 22px rgba(0,0,0,0.06)",
    textAlign: "center",
  };

  const panel = {
    marginTop: 18,
    textAlign: "center",
    border: `1px solid ${COLORS.border}`,
    borderRadius: 16,
    padding: isMobile ? 12 : 14,
    background: COLORS.soft,
  };

  const panelTitle = {
    fontWeight: 1000,
    color: COLORS.navy,
    textAlign: "center",
    fontSize: 18,
  };

  // ✅ shared “neat centered” width for BOTH inputs + buttons
  const fieldWrap = {
    width: "100%",
    maxWidth: 520,
    marginLeft: "auto",
    marginRight: "auto",
  };

  const input = {
    width: "100%",
    padding: isMobile ? "16px 14px" : "14px 14px",
    borderRadius: 14,
    border: `1px solid ${COLORS.border}`,
    outline: "none",
    fontSize: 16,
    textAlign: "left",
    background: "#fff",
    boxSizing: "border-box",
  };

  const goBtn = {
    padding: "14px 18px",
    borderRadius: 14,
    border: `2px solid ${COLORS.navy}`,
    background: COLORS.navy,
    color: "white",
    fontWeight: 1000,
    cursor: "pointer",
    width: "100%", // ✅ matches input width
    boxSizing: "border-box",
  };

  const createBtn = {
    padding: "14px 18px",
    borderRadius: 14,
    border: `2px solid ${COLORS.navy}`,
    background: COLORS.orange,
    color: COLORS.navy,
    fontWeight: 1000,
    cursor: creating ? "not-allowed" : "pointer",
    opacity: creating ? 0.7 : 1,
    width: "100%", // ✅ matches input width
    boxSizing: "border-box",
  };

  function go() {
    const id = normalizeLeagueId(leagueId);
    if (!id) return;
    navigate(`/league/${encodeURIComponent(id)}`);
  }

  async function createLeague() {
    setCreateMsg("");
    setCreateMsgColor(COLORS.muted);

    const id = normalizeLeagueId(newLeagueId);

    if (!id) {
      setCreateMsgColor(COLORS.red);
      setCreateMsg("Enter a new league id.");
      return;
    }
    if (!isValidLeagueId(id)) {
      setCreateMsgColor(COLORS.red);
      setCreateMsg("League id must be 2–40 chars: letters, numbers, - or _");
      return;
    }

    const pw = window.prompt("Admin password:");
    if (pw !== ADMIN_PASSWORD) {
      alert("Wrong password.");
      return;
    }

    setCreating(true);
    try {
      await ensureAnonAuth();

      const leagueRef = doc(db, "leagues", id);
      const existing = await getDoc(leagueRef);
      if (existing.exists()) {
        setCreateMsgColor(COLORS.red);
        setCreateMsg("That league id already exists.");
        return;
      }

      await setDoc(
        leagueRef,
        {
          createdAt: Date.now(),
          leagueId: id,
        },
        { merge: true }
      );

      setCreateMsgColor(COLORS.green);
      setCreateMsg("✅ League created.");
      setNewLeagueId("");

      navigate(`/league/${encodeURIComponent(id)}`);
    } catch (err) {
      setCreateMsgColor(COLORS.red);
      setCreateMsg(`❌ Failed: ${err?.message || String(err)}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={pageWrap}>
      <div style={container}>
        <div style={card}>
          <Header />

          <h2 style={{ marginTop: 12, color: COLORS.navy }}>Search League</h2>

          {/* Go to league */}
          <div style={panel}>
            <div style={panelTitle}>Go to league by ID</div>

            <div style={{ marginTop: 12, ...fieldWrap }}>
              {/* Desktop: input + button on one row. Mobile: stacks. */}
              <div
                style={{
                  display: "flex",
                  flexDirection: isMobile ? "column" : "row",
                  gap: 10,
                  alignItems: "stretch",
                  justifyContent: "center",
                }}
              >
                <div style={{ flex: 1 }}>
                  <input
                    style={input}
                    placeholder="Enter league id..."
                    value={leagueId}
                    onChange={(e) => setLeagueId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") go();
                    }}
                  />
                </div>

                <div style={{ width: isMobile ? "100%" : 120 }}>
                  <button style={goBtn} onClick={go}>
                    Go
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Create new league */}
          <div style={{ ...panel, marginTop: 14 }}>
            <div style={panelTitle}>Create New League (Admin)</div>

            <div
              style={{ marginTop: 12, ...fieldWrap, display: "grid", gap: 10 }}
            >
              <input
                style={input}
                placeholder="New league id (ex: pescado, winter-2026)"
                value={newLeagueId}
                onChange={(e) => setNewLeagueId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createLeague();
                }}
              />

              <button
                style={createBtn}
                onClick={createLeague}
                disabled={creating}
              >
                {creating ? "Creating..." : "Create League"}
              </button>

              {!!createMsg && (
                <div
                  style={{
                    fontWeight: 900,
                    color: createMsgColor,
                    textAlign: "center",
                  }}
                >
                  {createMsg}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
        <div
          style={{
            marginTop: 16,
            fontSize: 12,
            opacity: 0.7,
            textAlign: "center",
          }}
        >
          Developed by Eli Morgan
        </div>
      </div>
    </div>
  );
}
