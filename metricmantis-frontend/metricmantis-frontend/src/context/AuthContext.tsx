"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  getCurrentUser,
  loginAccount,
  logoutAccount,
  setUnauthorizedHandler,
  signupAccount,
  type AuthUser,
} from "@/lib/api";

const SESSION_HINT = "metricmantis.hadSession";

export interface AuthNotice {
  type: "success" | "error";
  text: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  notice: AuthNotice | null;
  freshLogin: boolean;
  login: (username: string, password: string) => Promise<void>;
  signup: (username: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearNotice: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  const [freshLogin, setFreshLogin] = useState(false);

  useEffect(() => {
    let cancelled = false;

    getCurrentUser()
      .then((result) => {
        if (cancelled) return;
        if (result.authenticated) {
          setUser(result.user);
          window.localStorage.setItem(SESSION_HINT, "1");
          return;
        }
        setUser(null);
        if (window.localStorage.getItem(SESSION_HINT) === "1") {
          window.localStorage.removeItem(SESSION_HINT);
          setNotice({
            type: "error",
            text: "Your session has ended. Please log in again.",
          });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setUser(null);
        setNotice({
          type: "error",
          text: "Unable to connect to the server. Please try again.",
        });
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      window.localStorage.removeItem(SESSION_HINT);
      setNotice({
        type: "error",
        text: "Your session has ended. Please log in again.",
      });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await loginAccount({ username, password });
    if (!result.user) {
      throw new Error("Unable to connect to the server. Please try again.");
    }
    setUser(result.user);
    setFreshLogin(true);
    setNotice({ type: "success", text: "Logged in successfully." });
    window.localStorage.setItem(SESSION_HINT, "1");
  }, []);

  const signup = useCallback(
    async (username: string, email: string, password: string) => {
      await signupAccount({ username, email, password });
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await logoutAccount();
    } catch (error) {
      setNotice({
        type: "error",
        text:
          error instanceof Error
            ? error.message
            : "Unable to connect to the server. Please try again.",
      });
      throw error;
    }
    setUser(null);
    setFreshLogin(false);
    window.localStorage.removeItem(SESSION_HINT);
    setNotice({ type: "success", text: "Logged out successfully." });
  }, []);

  const clearNotice = useCallback(() => setNotice(null), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: user !== null,
      isLoading,
      notice,
      freshLogin,
      login,
      signup,
      logout,
      clearNotice,
    }),
    [user, isLoading, notice, freshLogin, login, signup, logout, clearNotice],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
