import React, { useMemo, useState } from "react";
import Header from "../components/Header";
import { db, ensureAnonAuth } from "../firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

const ADMIN_PASSWORD = "Pescado!";

export default function CloneLeaguePage() {
  const [fromId, setFromId] = useState("default-league");
  const [toId, setToId] = useState("pescado");
  const [msg, setMsg] = useState("");

  async function runClone() {
    setMsg("");
    const pw = window.prompt("Admin password:");
    if (pw !== ADMIN_PASSWORD) {
      setMsg("❌ Wrong password.");
      return;
    }

    if (!fromId.trim() || !toId.trim()) {
      setMsg("❌ Please enter both From + To league IDs.");
      return;
    }

    if (fromId.trim() === toId.trim()) {
      setMsg("❌ From and To cannot be the same.");
      return;
    }

    await ensureAnonAuth();

    const fromRef = doc(db, "leagues", fromId.trim());
    const toRef = doc(db, "leagues", toId.trim());

    const fromSnap = await getDoc(fromRef);
    if (!fromSnap.exists()) {
      setMsg(`❌ Source league "${fromId}" does not exist.`);
      return;
    }

    const toSnap = await getDoc(toRef);
    if (toSnap.exists()) {
      const ok = window.confirm(
        `Destination "${toId}" already exists. Overwrite it completely?`
      );
      if (!ok) {
        setMsg("Cancelled.");
        return;
      }
    }

    const data = fromSnap.data();

    // Writes the entire document in one shot
    await setDoc(toRef, data);

    setMsg(`✅ Cloned "${fromId}" → "${toId}" successfully.`);
  }

  return (
    <div style={{ padding: 20, maxWidth: 720, margin: "0 auto" }}>
      <Header />
      <h2>Clone League (one-time admin tool)</h2>

      <div style={{ display: "grid", gap: 10 }}>
        <label>
          From leagueId:
          <input
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
            style={{ width: "100%", padding: 10, marginTop: 6 }}
          />
        </label>

        <label>
          To leagueId:
          <input
            value={toId}
            onChange={(e) => setToId(e.target.value)}
            style={{ width: "100%", padding: 10, marginTop: 6 }}
          />
        </label>

        <button
          onClick={runClone}
          style={{
            padding: 12,
            fontWeight: 800,
            cursor: "pointer",
            borderRadius: 10,
          }}
        >
          Clone League
        </button>

        {msg ? <div style={{ fontWeight: 800 }}>{msg}</div> : null}
      </div>

      <div style={{ marginTop: 14, fontSize: 12, opacity: 0.7 }}>
        After cloning, go to your league route like <b>/league/pescado</b>.
        You can delete this page afterward.
      </div>
    </div>
  );
}
