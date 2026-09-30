"use client";

interface PageActionsProps {
  onContinue?: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
}

export function PageActions({
  onContinue,
  continueLabel = "Continue →",
  continueDisabled = false,
}: PageActionsProps) {
  if (!onContinue) return null;
  return (
    <div className="page-actions">
      <button
        type="button"
        className="btn-primary"
        onClick={onContinue}
        disabled={continueDisabled}
      >
        {continueLabel}
      </button>
    </div>
  );
}
