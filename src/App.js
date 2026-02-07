// src/App.js
import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import TagsPage from "./pages/TagsPage";
import PuttingPage from "./pages/PuttingPage";
import DoublesPage from "./pages/DoublesPage";
import CloneLeaguePage from "./pages/CloneLeaguePage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Home: send to your primary league route */}
        <Route
          path="/"
          element={<Navigate to="/league/default-league" replace />}
        />

        {/* Per-league pages */}
        <Route path="/league/:leagueId" element={<TagsPage />} />
        <Route path="/league/:leagueId/putting" element={<PuttingPage />} />
        <Route path="/league/:leagueId/doubles" element={<DoublesPage />} />

        {/* Clone League utility page */}
        <Route path="/clone-league" element={<CloneLeaguePage />} />

        {/* Fallback */}
        <Route
          path="*"
          element={<Navigate to="/league/default-league" replace />}
        />
      </Routes>
    </BrowserRouter>
  );
}
