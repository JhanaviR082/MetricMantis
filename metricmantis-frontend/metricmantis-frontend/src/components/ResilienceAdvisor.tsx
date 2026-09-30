"use client";

import { useRef, useState } from "react";
import {
  postAdvisorSummary,
  postAdvisorChat,
  type AdvisorChatMessage,
  type AdvisorReport,
} from "@/lib/api";

interface ResilienceAdvisorProps {
  report: AdvisorReport;
}

type AdvisorState = "idle" | "loading-summary" | "ready" | "error-summary";

export function ResilienceAdvisor({ report }: ResilienceAdvisorProps) {
  const [state, setState] = useState<AdvisorState>("idle");
  const [summary, setSummary] = useState<string>("");
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([]);
  const [summaryError, setSummaryError] = useState<string>("");

  const [chatHistory, setChatHistory] = useState<AdvisorChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState("");

  const chatBottomRef = useRef<HTMLDivElement>(null);

  async function handleSummarize() {
    if (!report.sections.length && !report.scores) {
      setSummaryError("No report data available. Run an analysis first.");
      setState("error-summary");
      return;
    }
    setState("loading-summary");
    setSummaryError("");
    try {
      const res = await postAdvisorSummary(report);
      setSummary(res.summary);
      setSuggestedQuestions(res.suggestedQuestions ?? []);
      setState("ready");
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Something went wrong. Please try again.";
      setSummaryError(msg);
      setState("error-summary");
    }
  }

  async function handleAsk(question: string) {
    const q = question.trim();
    if (!q || chatLoading) return;
    setChatInput("");
    setChatError("");
    setChatLoading(true);

    const userMsg: AdvisorChatMessage = { role: "user", content: q };
    const nextHistory = [...chatHistory, userMsg];
    setChatHistory(nextHistory);

    // Scroll to bottom after state update
    setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

    try {
      const res = await postAdvisorChat(report, nextHistory, q);
      const advisorMsg: AdvisorChatMessage = { role: "advisor", content: res.answer };
      setChatHistory((prev) => [...prev, advisorMsg]);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Something went wrong. Please try again.";
      setChatError(msg);
    } finally {
      setChatLoading(false);
      setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }

  return (
    <div className="glass advisor-card">
      {/* ── Header ── */}
      <div className="advisor-header">
        <div className="advisor-header-icon">✦</div>
        <div>
          <div className="advisor-title">Resilience Advisor</div>
          {state === "idle" && (
            <div className="advisor-sub">
              Understand your resilience report in simple words
            </div>
          )}
        </div>
      </div>

      {/* ── Idle: call-to-action ── */}
      {state === "idle" && (
        <div className="advisor-cta">
          <button type="button" className="btn-primary advisor-btn" onClick={handleSummarize}>
            Summarize My Report
          </button>
        </div>
      )}

      {/* ── Loading summary ── */}
      {state === "loading-summary" && (
        <div className="advisor-loading">
          <span className="advisor-spinner" />
          Analyzing your report...
        </div>
      )}

      {/* ── Summary error ── */}
      {state === "error-summary" && (
        <div className="advisor-section">
          <p className="advisor-inline-error">{summaryError}</p>
          <button
            type="button"
            className="btn-ghost advisor-btn-sm"
            onClick={handleSummarize}
          >
            Try again
          </button>
        </div>
      )}

      {/* ── Summary ready ── */}
      {state === "ready" && (
        <>
          {/* Summary text */}
          <div className="advisor-section">
            <div className="advisor-section-label">Summary</div>
            <p className="advisor-summary-text">{summary}</p>
          </div>

          {/* Suggested questions */}
          {suggestedQuestions.length > 0 && (
            <div className="advisor-section">
              <div className="advisor-section-label">Suggested questions</div>
              <div className="advisor-questions">
                {suggestedQuestions.map((q, i) => (
                  <button
                    key={i}
                    type="button"
                    className="advisor-question-chip"
                    onClick={() => handleAsk(q)}
                    disabled={chatLoading}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Chat history */}
          {chatHistory.length > 0 && (
            <div className="advisor-section advisor-chat-history">
              {chatHistory.map((msg, i) => (
                <div
                  key={i}
                  className={`advisor-message advisor-message--${msg.role}`}
                >
                  <span className="advisor-message-role">
                    {msg.role === "user" ? "You" : "Advisor"}
                  </span>
                  <span className="advisor-message-content">{msg.content}</span>
                </div>
              ))}
              {chatLoading && (
                <div className="advisor-message advisor-message--advisor">
                  <span className="advisor-message-role">Advisor</span>
                  <span className="advisor-thinking">
                    <span className="advisor-spinner advisor-spinner--sm" />
                    Advisor is thinking...
                  </span>
                </div>
              )}
              <div ref={chatBottomRef} />
            </div>
          )}

          {/* Chat error */}
          {chatError && (
            <div className="advisor-section">
              <p className="advisor-inline-error">{chatError}</p>
            </div>
          )}

          {/* Chat input */}
          <div className="advisor-section advisor-input-row">
            <input
              className="advisor-input"
              type="text"
              placeholder="Ask anything about your report..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAsk(chatInput);
              }}
              disabled={chatLoading}
            />
            <button
              type="button"
              className="advisor-send-btn"
              onClick={() => handleAsk(chatInput)}
              disabled={chatLoading || !chatInput.trim()}
              aria-label="Send question"
            >
              ↑
            </button>
          </div>
        </>
      )}

      <style>{`
        .advisor-card {
          padding: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          gap: 0;
        }

        .advisor-header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 14px 16px 12px;
          border-bottom: 1px solid var(--border);
        }

        .advisor-header-icon {
          width: 28px;
          height: 28px;
          border-radius: 8px;
          background: rgba(255,255,255,0.06);
          border: 1px solid var(--border2);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          color: var(--silver);
          flex-shrink: 0;
        }

        .advisor-title {
          font-size: 12px;
          font-weight: 700;
          color: var(--bone);
          letter-spacing: -0.01em;
          line-height: 1.2;
        }

        .advisor-sub {
          font-family: var(--mono);
          font-size: 9px;
          color: var(--ash);
          margin-top: 1px;
        }

        .advisor-cta {
          padding: 14px 16px;
        }

        .advisor-btn {
          font-size: 12px;
          padding: 9px 18px;
          width: 100%;
        }

        .advisor-btn-sm {
          font-size: 11px;
          padding: 7px 14px;
        }

        .advisor-loading {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 14px 16px;
          font-family: var(--mono);
          font-size: 10px;
          color: var(--pewter);
        }

        .advisor-spinner {
          display: inline-block;
          width: 12px;
          height: 12px;
          border: 1.5px solid rgba(255,255,255,0.12);
          border-top-color: var(--silver);
          border-radius: 50%;
          animation: advisorSpin 0.7s linear infinite;
          flex-shrink: 0;
        }

        .advisor-spinner--sm {
          width: 9px;
          height: 9px;
          border-width: 1.5px;
        }

        @keyframes advisorSpin {
          to { transform: rotate(360deg); }
        }

        .advisor-section {
          padding: 10px 16px;
          border-top: 1px solid var(--border);
        }

        .advisor-section:first-of-type {
          border-top: none;
        }

        .advisor-section-label {
          font-family: var(--mono);
          font-size: 9px;
          text-transform: uppercase;
          letter-spacing: 0.14em;
          color: var(--ash);
          margin-bottom: 6px;
        }

        .advisor-summary-text {
          font-family: var(--mono);
          font-size: 10px;
          line-height: 1.75;
          color: var(--silver);
        }

        .advisor-questions {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }

        .advisor-question-chip {
          text-align: left;
          font-family: var(--mono);
          font-size: 10px;
          color: var(--pewter);
          background: rgba(255,255,255,0.03);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 6px 10px;
          cursor: pointer;
          transition: all 0.15s;
          line-height: 1.4;
        }

        .advisor-question-chip:hover:not(:disabled) {
          background: rgba(255,255,255,0.07);
          color: var(--chalk);
          border-color: var(--border2);
        }

        .advisor-question-chip:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .advisor-chat-history {
          max-height: 280px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
          scrollbar-width: thin;
          scrollbar-color: var(--cinder) transparent;
        }

        .advisor-message {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .advisor-message-role {
          font-family: var(--mono);
          font-size: 8px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }

        .advisor-message--user .advisor-message-role {
          color: var(--pewter);
        }

        .advisor-message--advisor .advisor-message-role {
          color: var(--ok);
        }

        .advisor-message-content {
          font-family: var(--mono);
          font-size: 10px;
          line-height: 1.7;
          color: var(--silver);
          white-space: pre-wrap;
        }

        .advisor-message--user .advisor-message-content {
          color: var(--bone);
        }

        .advisor-thinking {
          display: flex;
          align-items: center;
          gap: 6px;
          font-family: var(--mono);
          font-size: 10px;
          color: var(--ash);
        }

        .advisor-inline-error {
          font-family: var(--mono);
          font-size: 10px;
          color: var(--danger);
          line-height: 1.5;
          margin-bottom: 8px;
        }

        .advisor-input-row {
          display: flex;
          align-items: center;
          gap: 7px;
          padding-bottom: 12px;
        }

        .advisor-input {
          flex: 1;
          background: rgba(255,255,255,0.04);
          border: 1px solid var(--border);
          border-radius: 7px;
          padding: 7px 10px;
          font-family: var(--mono);
          font-size: 10px;
          color: var(--chalk);
          outline: none;
          transition: border-color 0.15s;
        }

        .advisor-input::placeholder {
          color: var(--ash);
        }

        .advisor-input:focus {
          border-color: var(--border3);
        }

        .advisor-input:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .advisor-send-btn {
          width: 28px;
          height: 28px;
          border-radius: 7px;
          background: rgba(255,255,255,0.07);
          border: 1px solid var(--border2);
          color: var(--silver);
          font-size: 13px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          transition: all 0.15s;
        }

        .advisor-send-btn:hover:not(:disabled) {
          background: rgba(255,255,255,0.13);
          color: var(--chalk);
          border-color: var(--border3);
        }

        .advisor-send-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}
