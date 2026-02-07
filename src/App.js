// src/App.js
import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import LeaguePage from "./pages/LeaguePage"; // league chooser
import LeagueHomePage from "./pages/LeagueHomePage"; // ✅ new hub page
import TagsPage from "./pages/TagsPage";
import PuttingPage from "./pages/PuttingPage";
import DoublesPage from "./pages/DoublesPage";
import CloneLeaguePage from "./pages/CloneLeaguePage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Home = League chooser */}
        <Route path="/" element={<LeaguePage />} />

        {/* ✅ League hub (NOT Tags) */}
        <Route path="/league/:leagueId" element={<LeagueHomePage />} />

        {/* ✅ Actual pages */}
        <Route path="/league/:leagueId/tags" element={<TagsPage />} />
        <Route path="/league/:leagueId/putting" element={<PuttingPage />} />
        <Route path="/league/:leagueId/doubles" element={<DoublesPage />} />

        {/* Utility */}
        <Route path="/clone-league" element={<CloneLeaguePage />} />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
