import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import { Navbar } from "./components/Navbar";
import { LandingPage } from "./pages/LandingPage";
import { AuthPage } from "./pages/AuthPage";
import { EventListPage } from "./pages/EventListPage";
import { EventDetailPage } from "./pages/EventDetailPage";
import { QueueScreen } from "./pages/QueueScreen";
import { OperationsDashboard } from "./pages/OperationsDashboard";
import { OrganizerDashboard } from "./pages/OrganizerDashboard";
import { SimulationPage } from "./pages/SimulationPage";

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col selection:bg-teal-500/30 selection:text-teal-200">
          <Navbar />
          <main className="flex-1">
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="/auth" element={<AuthPage />} />
              <Route path="/events" element={<EventListPage />} />
              <Route path="/events/:id" element={<EventDetailPage />} />
              <Route path="/queue/:id" element={<QueueScreen />} />
              <Route path="/ops" element={<OperationsDashboard />} />
              <Route path="/simulate" element={<SimulationPage />} />
              <Route path="/organizer" element={<OrganizerDashboard />} />
            </Routes>
          </main>
          <footer className="border-t border-white/5 py-8 text-center text-xs text-slate-500 font-mono">
            SurgeShield Resilience Platform · Adaptive Surge Partitions & Zero Overbooking Engine
          </footer>
        </div>
      </BrowserRouter>
    </AuthProvider>
  );
}
export default App;
