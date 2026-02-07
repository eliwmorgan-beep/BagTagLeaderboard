import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import HomePage from "./pages/HomePage";
import LeaguePage from "./pages/LeaguePage";
import TagsPage from "./pages/TagsPage";
import PuttingPage from "./pages/PuttingPage";
import DoublesPage from "./pages/DoublesPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* League chooser */}
        <Route path="/" element={<HomePage />} />

        {/* League hub */}
        <Route path="/league/:leagueId" element={<LeaguePage />} />

        {/* League-specific sections */}
        <Route path="/league/:leagueId/tags" element={<TagsPage />} />
        <Route path="/league/:leagueId/putting" element={<PuttingPage />} />
        <Route path="/league/:leagueId/doubles" element={<DoublesPage />} />

        {/* Old routes -> send home */}
        <Route path="/tags" element={<Navigate to="/" replace />} />
        <Route path="/putting" element={<Navigate to="/" replace />} />
        <Route path="/doubles" element={<Navigate to="/" replace />} />
        <Route path="/league" element={<Navigate to="/" replace />} />

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
