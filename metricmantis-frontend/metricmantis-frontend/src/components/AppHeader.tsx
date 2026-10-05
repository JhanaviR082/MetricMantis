"use client";

import { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { PAGE_ORDER, useSystem, type WorkflowPage } from "@/context/SystemContext";

const LABELS: Record<WorkflowPage, string> = {
  upload: "Upload",
  graph: "Graph",
  chaos: "Chaos",
  report: "Report",
};

export function AppHeader() {
  const { page, setPage, openGuide, goBack, analyzed } = useSystem();
  const { user, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const workflowIndex = page === "guide" ? -1 : PAGE_ORDER.indexOf(page);
  const canGoBack = page === "guide" || workflowIndex > 0;

  async function onLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      setLoggingOut(false);
    }
  }

  return (
    <header className="app-header">
      <div className="app-header-left">
        {canGoBack ? (
          <button type="button" className="app-back-btn" onClick={goBack}>
            ← Back
          </button>
        ) : (
          <span className="app-back-placeholder" />
        )}
        <div className="app-logo">
          Metric<span>Mantis</span>
        </div>
      </div>
      <nav className="app-nav" aria-label="Main">
        {PAGE_ORDER.map((p) => {
          const disabled =
            (p === "graph" || p === "chaos" || p === "report") && !analyzed;
          return (
            <button
              key={p}
              type="button"
              className={`app-nav-link${page === p ? " active" : ""}`}
              disabled={disabled}
              onClick={() => !disabled && setPage(p)}
            >
              {LABELS[p]}
            </button>
          );
        })}
        <button
          type="button"
          className={`app-nav-link app-nav-link--guide${page === "guide" ? " active" : ""}`}
          onClick={openGuide}
          title="What is MetricMantis? How to use the platform"
        >
          ✦ Platform Guide
        </button>
      </nav>
      <div className="app-header-right">
        {user && <span className="app-user">{user.username}</span>}
        <button
          type="button"
          className="app-nav-link"
          onClick={() => void onLogout()}
          disabled={loggingOut}
        >
          Logout
        </button>
      </div>
    </header>
  );
}
