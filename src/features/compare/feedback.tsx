import type { ComparisonActionState } from "@/server/comparisons/actions";

export function Feedback({ state }: { state: ComparisonActionState }) {
  return (
    <div aria-live="polite" className="min-h-6">
      {state.status === "error" && (
        <p role="alert" className="text-body-md text-danger">
          {state.message}
        </p>
      )}
      {state.status === "ok" && (
        <p className="text-body-md text-action-secondary">{state.message}</p>
      )}
    </div>
  );
}

export function errorOf(state: ComparisonActionState) {
  return state.status === "error" ? state : null;
}
