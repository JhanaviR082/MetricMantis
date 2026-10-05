"use client";

import { useCallback, useRef, useState } from "react";
import { AppHeader } from "@/components/AppHeader";
import { AuthMessage } from "@/components/auth/AuthMessage";
import { AuthScreen } from "@/components/auth/AuthScreen";
import { Background } from "@/components/Background";
import { ChaosPage } from "@/components/pages/ChaosPage";
import { GraphPage } from "@/components/pages/GraphPage";
import { ReportPage } from "@/components/pages/ReportPage";
import { GuidePage } from "@/components/pages/GuidePage";
import { UploadPage } from "@/components/pages/UploadPage";
import { Splash } from "@/components/Splash";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { SystemProvider, useSystem } from "@/context/SystemContext";

export function MetricMantisApp() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

function AuthGate() {
  const { isAuthenticated, isLoading, notice } = useAuth();
  const [splashExiting, setSplashExiting] = useState(false);
  const [splashDismissed, setSplashDismissed] = useState(false);
  const splashExitStarted = useRef(false);

  const dismissSplash = useCallback(() => {
    if (splashExitStarted.current) return;
    splashExitStarted.current = true;
    setSplashExiting(true);
    setTimeout(() => setSplashDismissed(true), 860);
  }, []);

  const showSplash = !splashDismissed || isLoading;

  return (
    <>
      {showSplash && (
        <>
          <Background />
          <Splash visible exiting={splashExiting} onEnter={dismissSplash} />
        </>
      )}

      {splashDismissed && !isLoading && !isAuthenticated && (
        <>
          <Background />
          <AuthScreen />
        </>
      )}

      {splashDismissed && !isLoading && isAuthenticated && (
        <SystemProvider>
          <AppRoot sessionNotice={notice} />
        </SystemProvider>
      )}
    </>
  );
}

function AppRoot({
  sessionNotice,
}: {
  sessionNotice: { type: "success" | "error"; text: string } | null;
}) {
  return (
    <>
      <Background />
      <div className="app-shell">
        <AppHeader />
        {sessionNotice && (
          <div className="auth-banner">
            <AuthMessage notice={sessionNotice} />
          </div>
        )}
        <AppPages />
      </div>
    </>
  );
}

function AppPages() {
  const { page } = useSystem();

  switch (page) {
    case "upload":
      return <UploadPage />;
    case "graph":
      return <GraphPage />;
    case "chaos":
      return <ChaosPage />;
    case "report":
      return <ReportPage />;
    case "guide":
      return <GuidePage />;
    default:
      return <UploadPage />;
  }
}
