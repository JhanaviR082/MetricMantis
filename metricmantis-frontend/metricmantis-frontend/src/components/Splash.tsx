"use client";

interface SplashProps {
  visible: boolean;
  exiting: boolean;
  onEnter: () => void;
}

export function Splash({ visible, exiting, onEnter }: SplashProps) {
  if (!visible) return null;

  return (
    <div id="splash" className={exiting ? "exit" : ""}>
      <div className="splash-glass">
        <div className="s-grid" />
        <div className="s-orb s-orb-1" />
        <div className="s-orb s-orb-2" />
        <div className="s-eyebrow">Chaos Engineering Platform</div>
        <div className="s-logo">
          Metric<em style={{ fontStyle: "normal" }}>Mantis</em>
        </div>
        <p className="s-caption">
          Systems don&apos;t fail in production by accident.
          <br />
          We break them on purpose — so you can build
          <br />
          <span className="hl">&nbsp;resilience&nbsp;</span> before it costs you.
        </p>
        <button type="button" className="s-enter" onClick={onEnter}>
          ENTER PLATFORM ↗
        </button>
      </div>
    </div>
  );
}
