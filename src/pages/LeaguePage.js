import React, { useEffect, useMemo, useState } from "react";
import { useParams, NavLink } from "react-router-dom";
import Header from "../components/Header";
import { db, ensureAnonAuth } from "../firebase";
import { doc, onSnapshot } from "firebase/firestore";

export default function LeaguePage() {
  const { leagueId } = useParams();

  const COLORS = {
    blueLight: "#e6f3ff",
    navy: "#1b1f5a",
    orange: "#f4a83a",
  };

  const buttonStyle = {
    padding: "14px 18px",
    borderRadius: 14,
    border: `2px solid ${COLORS.navy}`,
    fontWeight: 1000,
    cursor: "pointer",
    textDecoration: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    maxWidth: 320,
    background: COLORS.orange,
    color: "#1a1a1a",
  };

  const cardStyle = {
    marginTop: 14,
    padding: 14,
    borderRadius: 14,
    border: "1px solid #ddd",
    background: "#fff",
  };

  const [loading, setLoading] = useState(false);
  const [leagueData, setLeagueData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let unsub = null;

    async function run() {
      setError("");
      setLeagueData(null);

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

  const summary = useMemo(() => {
    if (!leagueData || leagueData.__notFound) return null;

    const defendEnabled = !!leagueData?.defendMode?.enabled;

    const puttingPlayersCount = Array.isArray(leagueData?.putting?.players)
      ? leagueData.putting.players.length
      : Array.isArray(leagueData?.puttingLeague?.players)
      ? leagueData.puttingLeague.players.length
      : 0;

    const puttingStations =
      leagueData?.putting?.settings?.stations ??
      leagueData?.puttingLeague?.settings?.stations ??
      null;

    const puttingRounds =
      leagueData?.putting?.settings?.rounds ??
      leagueData?.puttingLeague?.settings?.rounds ??
      null;

    const doublesTeamsCount = Array.isArray(leagueData?.doubles?.teams)
      ? leagueData.doubles.teams.length
      : Array.isArray(leagueData?.doublesLeague?.teams)
      ? leagueData.doublesLeague.teams.length
      : 0;

    return {
      defendEnabled,
      puttingPlayersCount,
      puttingStations,
      puttingRounds,
      doublesTeamsCount,
    };
  }, [leagueData]);

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
      <div style={{ width: "100%", maxWidth: 760 }}>
        {/* ✅ Keep the existing Header/logo behavior */}
        <Header />

        <div style={{ marginTop: 18, textAlign: "center" }}>
          <h1 style={{ margin: 0 }}>League</h1>

          {!leagueId && (
            <div style={{ marginTop: 12, opacity: 0.85 }}>
              <p>No league selected.</p>
              <NavLink to="/" style={{ fontWeight: 900 }}>
                ← Back to league chooser
              </NavLink>
            </div>
          )}

          {leagueId && (
            <>
              <div style={{ marginTop: 6, opacity: 0.8, fontSize: 13 }}>
                League code: <b>{leagueId}</b>
              </div>

              {loading && <div style={{ marginTop: 12 }}>Loading league…</div>}

              {!!error && (
                <div
                  style={{ marginTop: 12, color: "#b00020", fontWeight: 900 }}
                >
                  {error}
                </div>
              )}

              {leagueData && leagueData.__notFound && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ color: "#b00020", fontWeight: 900 }}>
                    League not found.
                  </div>
                  <div style={{ marginTop: 8, opacity: 0.85 }}>
                    Double-check the league code you entered.
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <NavLink to="/" style={{ fontWeight: 900 }}>
                      ← Back to league chooser
                    </NavLink>
                  </div>
                </div>
              )}

              {leagueData && !leagueData.__notFound && (
                <>
                  <div style={cardStyle}>
                    <div style={{ fontWeight: 1000, fontSize: 16 }}>
                      {leagueData.displayName || leagueId}
                    </div>

                    {summary && (
                      <div
                        style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}
                      >
                        <div>
                          Defend Mode:{" "}
                          <b
                            style={{
                              color: summary.defendEnabled ? "#0a7a0a" : "#555",
                            }}
                          >
                            {summary.defendEnabled ? "ON" : "OFF"}
                          </b>
                        </div>

                        <div style={{ marginTop: 6 }}>
                          Putting: <b>{summary.puttingPlayersCount}</b> players
                          {summary.puttingStations != null &&
                          summary.puttingRounds != null
                            ? ` • ${summary.puttingStations} stations • ${summary.puttingRounds} rounds`
                            : ""}
                        </div>

                        <div style={{ marginTop: 6 }}>
                          Doubles: <b>{summary.doublesTeamsCount}</b> teams
                        </div>
                      </div>
                    )}
                  </div>

                  <div
                    style={{
                      marginTop: 16,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 14,
                    }}
                  >
                    <NavLink
                      to={`/league/${encodeURIComponent(leagueId)}/tags`}
                      style={buttonStyle}
                    >
                      Tags
                    </NavLink>

                    <NavLink
                      to={`/league/${encodeURIComponent(leagueId)}/putting`}
                      style={buttonStyle}
                    >
                      Putting
                    </NavLink>

                    <NavLink
                      to={`/league/${encodeURIComponent(leagueId)}/doubles`}
                      style={buttonStyle}
                    >
                      Doubles
                    </NavLink>

                    <NavLink to="/" style={{ marginTop: 4, fontWeight: 900 }}>
                      ← Back to league chooser
                    </NavLink>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
