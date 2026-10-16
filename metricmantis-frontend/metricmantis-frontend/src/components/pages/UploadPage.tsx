"use client";
import { useRef, useState } from "react";
import { PageActions } from "@/components/PageActions";
import { useSystem } from "@/context/SystemContext";
import type { SandboxRecord } from "@/lib/api";
import { runtimeDisplay } from "@/lib/sandboxRuntime";

function sandboxStatusText(sandbox: SandboxRecord) {
  if (sandbox.status === "running") return "Status: running. The approved sample is healthy.";
  if (sandbox.status === "starting") return "Status: starting. Waiting for the approved sample.";
  if (sandbox.status === "stopping") return "Status: stopping. Removing the approved sample.";
  if (sandbox.status === "stopped") return "Status: stopped. Sandbox containers were removed.";
  if (sandbox.status === "failed") return `Status: failed. ${sandbox.error || "The sandbox did not finish cleanly."}`;
  return "Status: created. Containers have not been started.";
}

export function UploadPage() {
 const {
  composeFileName,
  uploadSuccess,
  analyzed,
  analyzing,
  composeText,
  services,
  edges,
  uploadCompose,
  analyzeSystem,
  sandbox,
  sandboxRuntime,
  sandboxObserved,
  sandboxBusy,
  sandboxAction,
  sandboxError,
  runSandbox,
  stopSandbox,
  setPage,
} = useSystem();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
const handleFile = async (file: File | null) => {
  if (!file) return;

  setError(null);

  if (!/\.ya?ml$/i.test(file.name)) {
    setError("Please upload a Docker Compose YAML file (.yml or .yaml)");
    return;
  }

  try {
    await uploadCompose(file);
  } catch (err) {
    console.error(err);
    setError("Could not upload file");
  }
};

  const onAnalyze = async () => {
    setError(null);
    try {
      await analyzeSystem();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse compose file");
    }
  };

  return (
    <main className="app-page">
      <div className="page-content">
        <div className="slide-label">System ingest</div>
        <h1 className="slide-title">
          Upload <span className="grad-text">Docker Compose</span>
        </h1>
        <p className="page-desc">
          Drop your <code>docker-compose.yml</code> to extract services and
          dependencies.
        </p>

        <input
          ref={inputRef}
          type="file"
          className="hidden-input"
          accept=".yml,.yaml"
          onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
        />

        <div
          className={`upload-area${dragOver ? " uploading" : ""}${uploadSuccess ? " uploading" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFile(e.dataTransfer.files[0] ?? null);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
        >
          <div className="upload-icon">📦</div>
          <div className="upload-text-main">Drop your docker-compose.yml</div>
          <div className="upload-text-sub">YAML only · click or drag to upload</div>
        </div>

        {uploadSuccess && composeFileName && (
          <div className="upload-success glass">
            <span className="upload-success-icon">✓</span>
            <div>
              <strong>{composeFileName}</strong> uploaded successfully
              <span className="upload-success-sub">Ready to analyze</span>
            </div>
          </div>
        )}

        {error && <p className="page-error">{error}</p>}

        {uploadSuccess && (
          <div className="hero-actions" style={{ marginTop: 18 }}>
            <button
              type="button"
              className="btn-primary"
              onClick={onAnalyze}
              disabled={analyzing}
            >
              {analyzing ? "Analyzing…" : "Analyze System"}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={runSandbox}
              disabled={sandboxBusy || !composeText || sandbox?.status === "running" || sandbox?.status === "starting" || sandbox?.status === "stopping"}
            >
              {sandboxAction === "run" ? "Starting sandbox…" : "Run sandbox"}
            </button>
            <button
              type="button"
              className="chaos-btn"
              onClick={stopSandbox}
              disabled={sandboxBusy || !sandbox || sandbox.status === "stopped"}
            >
              {sandboxAction === "stop" ? "Stopping sandbox…" : "Stop sandbox"}
            </button>
          </div>
        )}
        {uploadSuccess && (
          <p className="page-desc">
            Run sandbox starts the server-approved sample. The uploaded Compose file is not executed.
          </p>
        )}

        {sandbox && (
          <div className="upload-success glass">
            <div>
              <strong>{sandbox.projectName}</strong>
              <span className="upload-success-sub">
                {sandboxStatusText(sandbox)}
              </span>
            </div>
          </div>
        )}

        {sandboxError && <p className="page-error">{sandboxError}</p>}

        {analyzed && services.length > 0 && (
          <div className="analysis-results glass">
            <h3>Dependencies &amp; health</h3>
            <p className="analysis-sub">
              {sandboxObserved
                ? "Docker status is inspected separately. The status beside each name is still the simulation."
                : "These statuses are simulated. They are not Docker measurements."}
            </p>
            <div className="services-list">
              {services.map((s) => (
                <div key={s.id} className="service-row glass-deep">
                  <span
                    className={`service-dot${s.status === "healthy" ? "" : ` ${s.status}`}`}
                  />
                  <span className="service-name">{s.name}</span>
                  <span className="service-status">Simulated: {s.status}</span>
                  {sandboxObserved && (
                    <span className="service-status">
                      Docker: {(() => {
                        const observed = sandboxRuntime?.services.find((service) => service.service === s.name);
                        return observed ? runtimeDisplay(observed) : "unknown";
                      })()}
                    </span>
                  )}
                </div>
              ))}
            </div>
            {edges.length > 0 && (
              <div className="dep-list">
                <h4>Dependency links</h4>
                {edges.map((e) => (
                  <div key={`${e.from}-${e.to}`} className="dep-row">
                    <span className="dep-from">{e.from}</span>
                    <span className="dep-arrow">→</span>
                    <span className="dep-to">{e.to}</span>
                    <span className="dep-health check-pass">simulated</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <PageActions
          onContinue={() => setPage("graph")}
          continueLabel="View dependency graph →"
          continueDisabled={!analyzed}
        />
      </div>
    </main>
  );
}
