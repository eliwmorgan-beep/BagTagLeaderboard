import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import HomePage from "./pages/HomePage";
import TagsPage from "./pages/TagsPage";
import PuttingPage from "./pages/PuttingPage";
import DoublesPage from "./pages/DoublesPage";
import LeaguePage from "./pages/LeaguePage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />

        {/* Existing pages */}
        <Route path="/tags" element={<TagsPage />} />
        <Route path="/putting" element={<PuttingPage />} />
        <Route path="/doubles" element={<DoublesPage />} />

        {/* League routes */}
        <Route path="/league" element={<LeaguePage />} />
        <Route path="/league/:leagueId" element={<LeaguePage />} />

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
