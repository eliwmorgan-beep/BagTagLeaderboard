// src/pages/LeaguePage.js
import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";
import { db, ensureAnonAuth } from "../firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

const ADMIN_PASSWORD = "Pescado!";

export default function LeaguePage() {
  const navigate = useNavigate();

  const APP_FOOTER = "Developed by Eli Morgan";

  const [leagueId, setLeagueId] = useState("");

  // Go-to-league messaging
  const [goMsg, setGoMsg] = useState("");
  const [goMsgColor, setGoMsgColor] = useState("rgba(0,0,0,0.65)");
  const [goBusy, setGoBusy] = useState(false);

  // Create league (admin)
  const [newLeagueId, setNewLeagueId] = useState("");
  const [createMsg, setCreateMsg] = useState("");
  const [createMsgColor, setCreateMsgColor] = useState("rgba(0,0,0,0.65)");
  const [adminOkUntil, setAdminOkUntil] = useState(0);

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

  const sectionBox = {
    marginTop: 18,
    textAlign: "left",
    border: `1px solid ${COLORS.border}`,
    borderRadius: 16,
    padding: 14,
    background: COLORS.soft,
  };

  const innerPanel = {
    marginTop: 10,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 16,
    padding: 14,
    background: "#ffffff",
  };

  const labelTitle = {
    fontWeight: 1000,
    color: COLORS.navy,
    textAlign: "center",
    fontSize: 20,
  };

  const input = {
    width: "100%",
    boxSizing: "border-box",
    padding: "14px 14px",
    borderRadius: 14,
    border: `1px solid ${COLORS.border}`,
    outline: "none",
    fontSize: 16,
    background: "#fff",
  };

  const btnBase = {
    width: "100%",
    boxSizing: "border-box",
    padding: "14px 18px",
    borderRadius: 14,
    border: `2px solid ${COLORS.navy}`,
    fontWeight: 1000,
    cursor: "pointer",
  };

  const goBtn = {
    ...btnBase,
    background: COLORS.navy,
    color: "white",
    opacity: goBusy ? 0.7 : 1,
  };

  const createBtn = {
    ...btnBase,
    background: COLORS.orange,
    color: COLORS.navy,
  };

  function isValidLeagueId(id) {
    // simple & safe: letters/numbers/_/-
    return /^[a-z0-9_-]{2,40}$/i.test(id);
  }

  async function requireAdmin(fn) {
    const now = Date.now();
    if (now < adminOkUntil) return fn();

    const pw = window.prompt("Admin password:");
    if (pw !== ADMIN_PASSWORD) {
      alert("Wrong password.");
      return;
    }
    setAdminOkUntil(now + 10 * 60 * 1000);
    return fn();
  }

  // ✅ FIXED: Go checks Firestore existence BEFORE navigating
  async function go() {
    const id = (leagueId || "").trim();

    setGoMsg("");
    setGoMsgColor(COLORS.muted);

    if (!id) return;

    if (!isValidLeagueId(id)) {
      setGoMsgColor(COLORS.red);
      setGoMsg(
        "Invalid league id. Use 2–40 characters: letters, numbers, hyphen (-), underscore (_)."
      );
      return;
    }

    try {
      setGoBusy(true);
      setGoMsgColor(COLORS.muted);
      setGoMsg("Checking league…");

      await ensureAnonAuth();

      const leagueRef = doc(db, "leagues", id);
      const snap = await getDoc(leagueRef);

      if (!snap.exists()) {
        setGoMsgColor(COLORS.red);
        setGoMsg("League not found.");
        return; // 🔴 do NOT navigate
      }

      setGoMsgColor(COLORS.green);
      setGoMsg("✅ League found. Opening…");

      navigate(`/league/${encodeURIComponent(id)}`);
    } catch (err) {
      setGoMsgColor(COLORS.red);
      setGoMsg(`❌ Error checking league: ${err?.message || String(err)}`);
    } finally {
      setGoBusy(false);
    }
  }

  async function createLeague() {
    setCreateMsg("");
    setCreateMsgColor(COLORS.muted);

    const idRaw = (newLeagueId || "").trim();
    const id = idRaw;

    if (!id) {
      setCreateMsgColor(COLORS.red);
      setCreateMsg("Please enter a new league id.");
      return;
    }
    if (!isValidLeagueId(id)) {
      setCreateMsgColor(COLORS.red);
      setCreateMsg(
        "League id must be 2–40 characters and only use letters, numbers, hyphen (-), or underscore (_)."
      );
      return;
    }

    await requireAdmin(async () => {
      try {
        setCreateMsgColor(COLORS.muted);
        setCreateMsg("Creating league…");

        await ensureAnonAuth();

        const leagueRef = doc(db, "leagues", id);
        const snap = await getDoc(leagueRef);

        if (snap.exists()) {
          setCreateMsgColor(COLORS.red);
          setCreateMsg("That league id already exists.");
          return;
        }

        // Create the league doc. Pages auto-work because they load by leagueId.
        await setDoc(
          leagueRef,
          {
            leagueId: id,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            // Optional: displayName: id,
          },
          { merge: true }
        );

        setCreateMsgColor(COLORS.green);
        setCreateMsg("✅ League created. Opening it now…");

        setTimeout(() => {
          navigate(`/league/${encodeURIComponent(id)}`);
        }, 400);
      } catch (err) {
        setCreateMsgColor(COLORS.red);
        setCreateMsg(`❌ Failed: ${err?.message || String(err)}`);
      }
    });
  }

  return (
    <div style={pageWrap}>
      <div style={container}>
        <div style={card}>
          <Header />
          <h2 style={{ marginTop: 12, color: COLORS.navy }}>Search League</h2>

          {/* Go to league */}
          <div style={sectionBox}>
            <div style={labelTitle}>Go to league by ID</div>

            <div style={innerPanel}>
              <div style={{ display: "grid", gap: 12, justifyItems: "center" }}>
                <input
                  style={input}
                  placeholder="Enter league id..."
                  value={leagueId}
                  onChange={(e) => setLeagueId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") go();
                  }}
                />

                <button style={goBtn} onClick={go} disabled={goBusy}>
                  {goBusy ? "Checking..." : "Go"}
                </button>

                {!!goMsg && (
                  <div style={{ fontWeight: 900, color: goMsgColor }}>
                    {goMsg}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Create league */}
          <div style={{ ...sectionBox, marginTop: 14 }}>
            <div style={labelTitle}>Create New League (Admin)</div>

            <div style={innerPanel}>
              <div style={{ display: "grid", gap: 12, justifyItems: "center" }}>
                <input
                  style={input}
                  placeholder="New league id (ex: pescado, winter-2026)"
                  value={newLeagueId}
                  onChange={(e) => setNewLeagueId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createLeague();
                  }}
                />

                <button style={createBtn} onClick={createLeague}>
                  Create League
                </button>

                {!!createMsg && (
                  <div style={{ fontWeight: 900, color: createMsgColor }}>
                    {createMsg}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 16, fontSize: 12, opacity: 0.6 }}>
            (League IDs are not listed here by design.)
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
            {APP_FOOTER}
          </div>
        </div>
      </div>
    </div>
  );
}
