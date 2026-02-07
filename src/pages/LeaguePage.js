import React, { useEffect, useState } from "react";
import { useParams, NavLink } from "react-router-dom";
import Header from "../components/Header";
import { db, ensureAnonAuth } from "../firebase";
import { doc, onSnapshot } from "firebase/firestore";

export default function LeaguePage() {
  const { leagueId } = useParams();

  const [loading, setLoading] = useState(false);
  const [leagueData, setLeagueData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let unsub = null;

    async function run() {
      setError("");
      setLeagueData(null);

      // If user is on /league with no leagueId param
      if (!leagueId) return;

      setLoading(true);

      try {
        await ensureAnonAuth();

        const ref = doc(db, "leagues", leagueId);
        unsub = onSnapshot(
          ref,
          (snap) => {
            if (!snap.exists()) {
              setLeagueData({ __notFound: true });
            } else {
              setLeagueData(snap.data());
            }
            setLoading(false);
          },
          (err) => {
            console.error(err);
            setError("Could not load this league.");
            setLoading(false);
          }
        );
      } catch (err) {
        console.error(err);
        setError("Could not load this league.");
        setLoading(false);
      }
    }

    run();

    return () => {
      if (unsub) unsub();
    };
  }, [leagueId]);

  return (
    <div>
      <Header />
      <div style={{ padding: 16, maxWidth: 900, margin: "0 auto" }}>
        <h1 style={{ marginBottom: 6 }}>League</h1>

        {!leagueId && (
          <div style={{ opacity: 0.85 }}>
            <p>
              No league selected yet. Go back to the homepage and press{" "}
              <b>League</b> to enter a league code.
            </p>
            <NavLink to="/" style={{ fontWeight: 900 }}>
              ← Back to Home
            </NavLink>
          </div>
        )}

        {leagueId && (
          <>
            <div style={{ marginTop: 10, opacity: 0.8 }}>
              League code: <b>{leagueId}</b>
            </div>

            {loading && <p style={{ marginTop: 12 }}>Loading league…</p>}

            {!!error && (
              <p style={{ marginTop: 12, color: "#b00020" }}>{error}</p>
            )}

            {leagueData && leagueData.__notFound && (
              <div style={{ marginTop: 12 }}>
                <p style={{ color: "#b00020", fontWeight: 900 }}>
                  League not found.
                </p>
                <p style={{ opacity: 0.85 }}>
                  Double-check the league code you entered.
                </p>
                <NavLink to="/" style={{ fontWeight: 900 }}>
                  ← Back to Home
                </NavLink>
              </div>
            )}

            {leagueData && !leagueData.__notFound && (
              <div
                style={{
                  marginTop: 14,
                  padding: 14,
                  borderRadius: 14,
                  border: "1px solid #ddd",
                  background: "#fff",
                }}
              >
                <div style={{ fontWeight: 1000, fontSize: 16 }}>
                  {leagueData.displayName || "Untitled League"}
                </div>

                <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
                  <div>
                    Players:{" "}
                    <b>
                      {Array.isArray(leagueData.players)
                        ? leagueData.players.length
                        : 0}
                    </b>
                  </div>
                  <div>
                    Tag rounds:{" "}
                    <b>
                      {Array.isArray(leagueData.rounds)
                        ? leagueData.rounds.length
                        : 0}
                    </b>
                  </div>
                </div>

                <div style={{ marginTop: 12, fontSize: 13, opacity: 0.85 }}>
                  (Next step: this page can become the “hub” for this
                  league—settings, leaderboards, and navigation into
                  Tags/Putting/Doubles for the selected league.)
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
