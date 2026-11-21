"use client";

import { CircleAlert, CircleCheck, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

export type ToastAction = {
  label: string;
  /** Resolve with an error message to show if the action could not be applied. */
  run: () => Promise<{ error?: string } | void>;
};

export type ToastInput = {
  message: string;
  tone?: "success" | "error";
  action?: ToastAction;
  durationMs?: number;
};

type ToastItem = ToastInput & { id: number };

type ToastApi = { toast: (input: ToastInput) => void };

const noop: ToastApi = { toast: () => undefined };
const ToastContext = createContext<ToastApi>(noop);

/** Outside a provider (public pages, tests) toasts are silently skipped; callers keep inline text. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const DEFAULT_MS = 7000;
const ERROR_MS = 10000;
const MAX_VISIBLE = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((input: ToastInput) => {
    const id = nextId.current++;
    setItems((current) => [...current, { ...input, id }].slice(-MAX_VISIBLE));
  }, []);

  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section
        aria-label="Notifications"
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-margin-mobile lg:bottom-6"
      >
        {items.map((item) => (
          <ToastView
            key={item.id}
            item={item}
            onDismiss={() => dismiss(item.id)}
            onReplace={toast}
          />
        ))}
      </section>
    </ToastContext.Provider>
  );
}

function ToastView({
  item,
  onDismiss,
  onReplace,
}: {
  item: ToastItem;
  onDismiss: () => void;
  onReplace: (input: ToastInput) => void;
}) {
  const [paused, setPaused] = useState(false);
  const [working, setWorking] = useState(false);
  const error = item.tone === "error";
  const Icon = error ? CircleAlert : CircleCheck;

  // Auto-dismiss, but never while the person is reading it, using it or has focus inside.
  useEffect(() => {
    if (paused || working) return;
    const timer = window.setTimeout(onDismiss, item.durationMs ?? (error ? ERROR_MS : DEFAULT_MS));
    return () => window.clearTimeout(timer);
  }, [paused, working, item.durationMs, error, onDismiss]);

  async function runAction() {
    if (!item.action) return;
    setWorking(true);
    try {
      const result = await item.action.run();
      onDismiss();
      if (result && result.error) onReplace({ message: result.error, tone: "error" });
    } catch {
      onDismiss();
      onReplace({ message: "That didn't work. Please try again.", tone: "error" });
    }
  }

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cn(
        "pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-card border px-4 py-3 shadow-ambient-sm",
        error
          ? "border-danger bg-danger-bg text-on-danger-bg"
          : "border-action-secondary bg-action-secondary text-on-action-secondary",
      )}
    >
      <Icon aria-hidden="true" className="size-5 shrink-0" />
      <p className="min-w-0 flex-1 text-body-md">{item.message}</p>
      {item.action && (
        <button
          type="button"
          onClick={runAction}
          disabled={working}
          className="min-h-11 shrink-0 rounded-control px-3 text-label-lg font-semibold underline underline-offset-4 disabled:opacity-70"
        >
          {working ? "Working…" : item.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full"
      >
        <X aria-hidden="true" className="size-5" />
      </button>
    </div>
  );
}
