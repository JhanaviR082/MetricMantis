"use client";

import { useCallback, useState } from "react";
import { AppHeader } from "@/components/AppHeader";
import { Background } from "@/components/Background";
import { ChaosPage } from "@/components/pages/ChaosPage";
import { GraphPage } from "@/components/pages/GraphPage";
import { ReportPage } from "@/components/pages/ReportPage";
import { GuidePage } from "@/components/pages/GuidePage";
import { UploadPage } from "@/components/pages/UploadPage";
import { Splash } from "@/components/Splash";
import { SystemProvider, useSystem } from "@/context/SystemContext";

export function MetricMantisApp() {
  return (
    <SystemProvider>
      <AppRoot />
    </SystemProvider>
  );
}

function AppRoot() {
  const [splashVisible, setSplashVisible] = useState(true);
  const [splashExiting, setSplashExiting] = useState(false);

  const dismissSplash = useCallback(() => {
    setSplashExiting(true);
    setTimeout(() => setSplashVisible(false), 860);
  }, []);

  return (
    <>
      <Background />
      <Splash
        visible={splashVisible}
        exiting={splashExiting}
        onEnter={dismissSplash}
      />

      {!splashVisible && (
        <div className="app-shell">
          <AppHeader />
          <AppPages />
        </div>
      )}
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
