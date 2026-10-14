"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { ThemeToggle } from "@/components/ThemeToggle";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { SystemProvider, useSystem } from "@/context/SystemContext";
import { ThemeProvider } from "@/context/ThemeContext";

export function MetricMantisApp() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <AuthGate />
      </ThemeProvider>
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

  // Clicking the logo resets to splash — re-show the splash screen
  const resetToSplash = useCallback(() => {
    splashExitStarted.current = false;
    setSplashExiting(false);
    setSplashDismissed(false);
  }, []);

  const showSplash = !splashDismissed || isLoading;

  return (
    <>
      {!isAuthenticated && <ThemeToggle floating />}
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
          <AppRoot sessionNotice={notice} onLogoClick={resetToSplash} />
        </SystemProvider>
      )}
    </>
  );
}

function AppRoot({
  sessionNotice,
  onLogoClick,
}: {
  sessionNotice: { type: "success" | "error"; text: string } | null;
  onLogoClick?: () => void;
}) {
  const { clearNotice } = useAuth();
  const [bannerVisible, setBannerVisible] = useState(true);

  useEffect(() => {
    setBannerVisible(true);
    if (!sessionNotice || sessionNotice.type !== "success") return;
    const id = setTimeout(() => {
      clearNotice();
      setBannerVisible(false);
    }, 3000);
    return () => clearTimeout(id);
  }, [sessionNotice, clearNotice]);

  const showBanner = sessionNotice && bannerVisible;

  return (
    <>
      <Background />
      <div className="app-shell">
        <AppHeader onLogoClick={onLogoClick} />
        {showBanner && (
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
