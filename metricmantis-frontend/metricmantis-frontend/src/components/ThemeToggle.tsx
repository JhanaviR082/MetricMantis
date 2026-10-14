"use client";

import { useTheme } from "@/context/ThemeContext";

export function ThemeToggle({ floating = false }: { floating?: boolean }) {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      type="button"
      className={`theme-toggle${floating ? " theme-toggle--floating" : ""}`}
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      aria-pressed={theme === "light"}
    >
      <span aria-hidden="true">☼</span>
    </button>
  );
}