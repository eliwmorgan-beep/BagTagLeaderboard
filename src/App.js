// src/App.js
import React from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";

import LeaguePage from "./pages/LeaguePage";
import TagsPage from "./pages/TagsPage";
import PuttingPage from "./pages/PuttingPage";
import DoublesPage from "./pages/DoublesPage";
import CloneLeaguePage from "./pages/CloneLeaguePage";

export default function App() {
  return (
    <HashRouter>
      <Routes>
        {/* Home = League selector / hub */}
        <Route path="/" element={<LeaguePage />} />

        {/* Per-league pages */}
        <Route path="/league/:leagueId" element={<TagsPage />} />
        <Route path="/league/:leagueId/putting" element={<PuttingPage />} />
        <Route path="/league/:leagueId/doubles" element={<DoublesPage />} />

        {/* Clone utility */}
        <Route path="/clone-league" element={<CloneLeaguePage />} />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
