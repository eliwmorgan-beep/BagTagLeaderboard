// src/pages/LeaguePage.js
import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";
import { db, ensureAnonAuth } from "../firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

const ADMIN_PASSWORD = "Pescado!"; // same pattern you use elsewhere

function sanitizeLeagueId(raw) {
  // Firestore doc ids can contain many chars, but keeping it simple avoids URL weirdness.
  const s = (raw || "").trim().toLowerCase();
  // allow letters, numbers, dash, underscore only
  const cleaned = s.replace(/[^a-z0-9_-]/g, "");
  return cleaned;
}

export default function LeaguePage() {
  const navigate = useNavigate();

  const [leagueId, setLeagueId] = useState("");

  // create-new-league fields
  const [newLeagueId, setNewLeagueId] = useState("");
  const [newLeagueName, setNewLeagueName] = useState("");
  const [createMsg, setCreateMsg] = useState("");
  const [createMsgColor, setCreateMsgColor] = useState("rgba(0,0,0,0.65)");
  const [creating, setCreating] = useState(false);

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

  const panel = {
    marginTop: 18,
    textAlign: "left",
    border: `1px solid ${COLORS.border}`,
    borderRadius: 16,
    padding: 14,
    background: COLORS.soft,
  };

  const input = {
    width: "100%",
    padding: "14px 14px",
    borderRadius: 14,
    border: `1px solid ${COLORS.border}`,
    outline: "none",
    fontSize: 16,
  };

  const btn = (primary = true) => ({
    padding: "14px 18px",
    borderRadius: 14,
    border: `2px solid ${COLORS.navy}`,
    background: primary ? COLORS.navy : "#fff",
    color: primary ? "white" : COLORS.navy,
    fontWeight: 1000,
    cursor: "pointer",
    minWidth: 120,
  });

  function go() {
    const id = sanitizeLeagueId(leagueId);
    if (!id) return;
    navigate(`/league/${encodeURIComponent(id)}`);
  }

  async function createLeague() {
    setCreateMsg("");
    setCreateMsgColor(COLORS.muted);

    const id = sanitizeLeagueId(newLeagueId);
    if (!id) {
      setCreateMsgColor(COLORS.red);
      setCreateMsg(
        "Please enter a valid league id (letters/numbers/dash/underscore)."
      );
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

      const ref = doc(db, "leagues", id);
      const snap = await getDoc(ref);

      if (snap.exists()) {
        setCreateMsgColor(COLORS.red);
        setCreateMsg(`League "${id}" already exists.`);
        setCreating(false);
        return;
      }

      // Minimal “league shell”. Each page can create its own subsection if missing,
      // but this gives you a nice display name + createdAt.
      const payload = {
        name: (newLeagueName || "").trim() || id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await setDoc(ref, payload, { merge: true });

      setCreateMsgColor(COLORS.green);
      setCreateMsg(`✅ League created: ${id}`);

      // jump straight into the new league
      navigate(`/league/${encodeURIComponent(id)}`);
    } catch (err) {
      setCreateMsgColor(COLORS.red);
      setCreateMsg(
        `❌ Failed to create league: ${err?.message || String(err)}`
      );
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
            <div style={{ fontWeight: 1000, color: COLORS.navy }}>
              Go to a league by ID
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
              <button style={btn(true)} onClick={go}>
                Go
              </button>
            </div>
          </div>

          {/* Create new league (Admin) */}
          <div style={panel}>
            <div style={{ fontWeight: 1000, color: COLORS.navy }}>
              Create New League (Admin)
            </div>
            <div
              style={{
                fontSize: 13,
                color: COLORS.muted,
                fontWeight: 800,
                marginTop: 4,
              }}
            >
              Creates a new league in Firestore. Pages
              (Home/Tags/Putting/Doubles) work automatically from the league id.
            </div>

            <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
              <input
                style={input}
                placeholder="New league id (ex: pescado, saturday_dubs, winter-2026)"
                value={newLeagueId}
                onChange={(e) => setNewLeagueId(e.target.value)}
              />

              <input
                style={input}
                placeholder='Display name (optional) (ex: "Pescado Mojado")'
                value={newLeagueName}
                onChange={(e) => setNewLeagueName(e.target.value)}
              />

              <div
                style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}
              >
                <button
                  style={{
                    ...btn(false),
                    border: `2px solid ${COLORS.navy}`,
                  }}
                  onClick={createLeague}
                  disabled={creating}
                  title="Password protected"
                >
                  {creating ? "Creating..." : "Create League"}
                </button>
              </div>

              {!!createMsg && (
                <div style={{ fontWeight: 900, color: createMsgColor }}>
                  {createMsg}
                </div>
              )}
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
