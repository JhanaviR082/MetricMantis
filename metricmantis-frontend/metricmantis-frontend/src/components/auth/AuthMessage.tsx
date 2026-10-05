import type { AuthNotice } from "@/context/AuthContext";

export function AuthMessage({ notice }: { notice: AuthNotice | null }) {
  if (!notice) return null;

  return (
    <p className={`auth-message auth-message--${notice.type}`} role="status">
      {notice.text}
    </p>
  );
}
