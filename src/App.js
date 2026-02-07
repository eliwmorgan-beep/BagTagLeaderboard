// src/App.js
import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import LeaguePage from "./pages/LeaguePage";
import LeagueHomePage from "./pages/LeagueHomePage";
import TagsPage from "./pages/TagsPage";
import PuttingPage from "./pages/PuttingPage";
import DoublesPage from "./pages/DoublesPage";
import CloneLeaguePage from "./pages/CloneLeaguePage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LeaguePage />} />
        <Route path="/league/:leagueId" element={<LeagueHomePage />} />
        <Route path="/league/:leagueId/tags" element={<TagsPage />} />
        <Route path="/league/:leagueId/putting" element={<PuttingPage />} />
        <Route path="/league/:leagueId/doubles" element={<DoublesPage />} />
        <Route path="/clone-league" element={<CloneLeaguePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
