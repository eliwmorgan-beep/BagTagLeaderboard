// src/App.js
import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import LeaguePage from "./pages/LeaguePage"; // ✅ league selector / hub
import TagsPage from "./pages/TagsPage";
import PuttingPage from "./pages/PuttingPage";
import DoublesPage from "./pages/DoublesPage";
import CloneLeaguePage from "./pages/CloneLeaguePage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* ✅ Home = League selector / hub */}
        <Route path="/" element={<LeaguePage />} />

        {/* ✅ Guard: /league with no id should go back to chooser */}
        <Route path="/league" element={<Navigate to="/" replace />} />

        {/* ✅ Per-league pages */}
        <Route path="/league/:leagueId" element={<TagsPage />} />
        <Route path="/league/:leagueId/putting" element={<PuttingPage />} />
        <Route path="/league/:leagueId/doubles" element={<DoublesPage />} />

        {/* ✅ Clone utility */}
        <Route path="/clone-league" element={<CloneLeaguePage />} />

        {/* ✅ Fallback → home (NOT default-league) */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
