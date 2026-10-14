"use client";

import { FormEvent, useState } from "react";
import { AuthMessage } from "@/components/auth/AuthMessage";
import { useAuth, type AuthNotice } from "@/context/AuthContext";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Mode = "login" | "signup";

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

          <label className="auth-field">
            <span>Password</span>
            <input
              name="password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              required
            />
          </label>

          {mode === "signup" && (
            <label className="auth-field">
              <span>Confirm Password</span>
              <input
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={submitting}
                required
              />
            </label>
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
