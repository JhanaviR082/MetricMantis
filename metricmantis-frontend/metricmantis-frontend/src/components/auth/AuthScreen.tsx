"use client";

import { FormEvent, useState } from "react";
import { AuthMessage } from "@/components/auth/AuthMessage";
import { useAuth, type AuthNotice } from "@/context/AuthContext";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Mode = "login" | "signup";

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function PasswordField({
  name,
  label,
  value,
  onChange,
  disabled,
  autoComplete,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  autoComplete: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="auth-field">
      <span>{label}</span>
      <div className="auth-password-wrap">
        <input
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          required
        />
        <button
          type="button"
          className="auth-eye-btn"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          tabIndex={-1}
        >
          <EyeIcon open={visible} />
        </button>
      </div>
    </label>
  );
}

export function AuthScreen() {
  const { login, signup, notice, clearNotice } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localNotice, setLocalNotice] = useState<AuthNotice | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const visibleNotice = localNotice ?? notice;

  function switchMode(next: Mode) {
    setMode(next);
    setLocalNotice(null);
    clearNotice();
    setPassword("");
    setConfirmPassword("");
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setLocalNotice(null);
    clearNotice();

    if (mode === "signup") {
      if (!username.trim() || !email.trim()) {
        setLocalNotice({
          type: "error",
          text: "Please provide a valid username, email, and password.",
        });
        return;
      }
      if (!EMAIL_PATTERN.test(email.trim())) {
        setLocalNotice({
          type: "error",
          text: "Please provide a valid username, email, and password.",
        });
        return;
      }
      if (password.length < 8) {
        setLocalNotice({
          type: "error",
          text: "Password must be at least 8 characters.",
        });
        return;
      }
      if (password !== confirmPassword) {
        setLocalNotice({
          type: "error",
          text: "Passwords do not match.",
        });
        return;
      }
    } else if (!username.trim() || !password) {
      setLocalNotice({
        type: "error",
        text: "Invalid username or password.",
      });
      return;
    }

    setSubmitting(true);
    try {
      if (mode === "signup") {
        await signup(username.trim(), email.trim(), password);
        setMode("login");
        setPassword("");
        setConfirmPassword("");
        setEmail("");
        setLocalNotice({
          type: "success",
          text: "Account created successfully.",
        });
      } else {
        await login(username.trim(), password);
      }
    } catch (error) {
      const text =
        error instanceof Error
          ? error.message
          : "Unable to connect to the server. Please try again.";
      setLocalNotice({ type: "error", text });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card glass">
        <p className="slide-label">MetricMantis</p>
        <h1 className="auth-title">
          {mode === "login" ? "Log in" : "Create an account"}
        </h1>
        <p className="auth-caption">
          {mode === "login"
            ? "Sign in to map a system and run chaos experiments."
            : "Choose a username, email, and password to get started."}
        </p>

        <form className="auth-form" onSubmit={onSubmit}>
          <label className="auth-field">
            <span>Username</span>
            <input
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={submitting}
              required
            />
          </label>

          {mode === "signup" && (
            <label className="auth-field">
              <span>Email</span>
              <input
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={submitting}
                required
              />
            </label>
          )}

          <PasswordField
            name="password"
            label="Password"
            value={password}
            onChange={setPassword}
            disabled={submitting}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />

          {mode === "signup" && (
            <PasswordField
              name="confirmPassword"
              label="Confirm Password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              disabled={submitting}
              autoComplete="new-password"
            />
          )}

          <AuthMessage notice={visibleNotice} />

          <button className="btn-primary auth-submit" type="submit" disabled={submitting}>
            {submitting
              ? "Please wait…"
              : mode === "login"
                ? "Login"
                : "Create Account"}
          </button>
        </form>

        {mode === "login" ? (
          <button
            type="button"
            className="auth-switch"
            onClick={() => switchMode("signup")}
          >
            Create an account
          </button>
        ) : (
          <button
            type="button"
            className="auth-switch"
            onClick={() => switchMode("login")}
          >
            Already have an account? Log in
          </button>
        )}
      </section>
    </main>
  );
}
