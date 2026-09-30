"use client";
import { uploadYaml } from "@/lib/api";
import { useRef, useState } from "react";
import { PageActions } from "@/components/PageActions";
import { useSystem } from "@/context/SystemContext";

export function UploadPage() {
 const {
  composeFileName,
  uploadSuccess,
  analyzed,
  analyzing,
  services,
  edges,
  uploadCompose,
  analyzeSystem,
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
          </div>
        )}

        {analyzed && services.length > 0 && (
          <div className="analysis-results glass">
            <h3>Dependencies &amp; health</h3>
            <p className="analysis-sub">
              All services start healthy until chaos is injected.
            </p>
            <div className="services-list">
              {services.map((s) => (
                <div key={s.id} className="service-row glass-deep">
                  <span
                    className={`service-dot${s.status !== "healthy" ? " down" : ""}`}
                  />
                  <span className="service-name">{s.name}</span>
                  <span className="service-status">{s.status}</span>
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
                    <span className="dep-health check-pass">healthy</span>
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
