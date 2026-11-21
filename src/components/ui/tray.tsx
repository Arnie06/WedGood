"use client";

import { X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

type TrayContextValue = {
  close: () => void;
  /** Closes the tray and confirms with a toast; used when a save succeeds. */
  complete: (message?: string) => void;
};
const TrayContext = createContext<TrayContextValue | null>(null);

/** Closes the surrounding tray (no-op outside one). */
export function useTrayClose(): () => void {
  const ctx = useContext(TrayContext);
  return ctx ? ctx.close : () => undefined;
}

type ActionState = { status: string; message?: string };

/**
 * `useActionState` for forms that may live in a tray. Outside a tray it behaves exactly like
 * `useActionState`. Inside one, a successful result (`status: "ok"`) closes the tray and shows
 * the result's message as a toast, unless `keepOpen` is set (forms that add several in a row).
 */
export function useTrayActionState<S extends ActionState>(
  action: (state: S, form: FormData) => Promise<S>,
  initial: S,
  options: { keepOpen?: boolean } = {},
) {
  const ctx = useContext(TrayContext);
  // Action states are plain objects, so `Awaited<S>` is `S`; React's generic signature just can't see that.
  return useActionState(async (prev: Awaited<S>, form: FormData) => {
    const next = await action(prev as S, form);
    if (ctx && next.status === "ok" && !options.keepOpen) ctx.complete(next.message);
    return next as Awaited<S>;
  }, initial as Awaited<S>);
}

const TRANSITION_MS = 220;

/**
 * A button (or text link) that opens a slide-out tray: from the right on larger screens, up from
 * the bottom on phones. Built on the native <dialog>, so focus is trapped, Escape closes, the page
 * behind is inert and focus returns to the trigger. The form inside is only mounted while the tray
 * is open, so a list can carry one tray per row without carrying every form.
 */
export function TrayButton({
  label,
  title,
  description,
  variant = "primary",
  size,
  triggerStyle = "button",
  ariaLabel,
  className,
  openOnParam,
  successMessage,
  children,
}: {
  label: ReactNode;
  title: string;
  description?: string | undefined;
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  /** "link" is an underlined text trigger; "plain" reads as ordinary text (a row title) and underlines on hover. */
  triggerStyle?: "button" | "link" | "plain";
  /** Needed when several triggers share the same visible label (for example per-row "Edit"). */
  ariaLabel?: string | undefined;
  className?: string | undefined;
  /** Opens on arrival when the URL has `?<name>=1` (used by the header Add menu), then tidies the URL. */
  openOnParam?: string | undefined;
  /** Toast shown after a save closes the tray, when the action gave no message of its own. */
  successMessage?: string | undefined;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { toast } = useToast();

  const open = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    setMounted(true);
  }, []);

  const finishClose = useCallback(() => {
    const dialog = ref.current;
    if (dialog?.open) dialog.close();
    setMounted(false);
  }, []);

  const close = useCallback(() => {
    setVisible(false);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(finishClose, TRANSITION_MS);
  }, [finishClose]);

  const complete = useCallback(
    (message?: string) => {
      close();
      toast({ message: message ?? successMessage ?? "Saved." });
    },
    [close, toast, successMessage],
  );

  // Once the children are in the DOM: open modally, slide in, put focus in the first field.
  useEffect(() => {
    const dialog = ref.current;
    if (!mounted || !dialog || dialog.open) return;
    dialog.showModal();
    const frame = window.requestAnimationFrame(() => setVisible(true));
    dialog
      .querySelector<HTMLElement>("input:not([type=hidden]), textarea, select")
      ?.focus({ preventScroll: true });
    return () => window.cancelAnimationFrame(frame);
  }, [mounted]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const wanted = openOnParam ? params.get(openOnParam) === "1" : false;
  useEffect(() => {
    if (!wanted || !openOnParam) return;
    const timer = window.setTimeout(open, 0);
    const next = new URLSearchParams(params.toString());
    next.delete(openOnParam);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  return (
    <>
      {triggerStyle !== "button" ? (
        <button
          type="button"
          onClick={open}
          aria-label={ariaLabel}
          className={cn(
            triggerStyle === "link"
              ? "inline-flex min-h-11 items-center text-label-lg font-semibold text-action-emphasis underline underline-offset-4"
              : "inline-flex min-h-11 items-center text-left text-body-lg underline-offset-4 hover:underline",
            className,
          )}
        >
          {label}
        </button>
      ) : (
        <Button
          type="button"
          variant={variant}
          {...(size ? { size } : {})}
          aria-label={ariaLabel}
          className={className}
          onClick={open}
        >
          {label}
        </Button>
      )}
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        data-state={visible ? "open" : "closed"}
        onCancel={(event) => {
          // Escape: slide out instead of vanishing.
          event.preventDefault();
          close();
        }}
        onClose={() => {
          setVisible(false);
          setMounted(false);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        className={cn(
          "fixed m-0 max-h-[90dvh] w-full max-w-none overflow-y-auto border border-border-hairline bg-surface p-0 text-ink shadow-ambient-sm backdrop:bg-ink/40",
          // Phones: a bottom sheet.
          "inset-x-0 top-auto bottom-0 translate-y-full rounded-t-card",
          "transition-transform duration-200 ease-out data-[state=open]:translate-y-0",
          // Larger screens: a tray sliding in from the right.
          "sm:inset-y-0 sm:right-0 sm:left-auto sm:max-h-none sm:h-dvh sm:w-[30rem] sm:translate-y-0 sm:translate-x-full sm:rounded-t-none sm:rounded-l-card sm:data-[state=open]:translate-x-0",
        )}
      >
        {mounted && (
          <TrayContext.Provider value={{ close, complete }}>
            <div className="flex min-h-full flex-col gap-4 p-5 sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <h2 id={titleId} className="font-serif text-headline-sm">
                    {title}
                  </h2>
                  {description && <p className="text-body-md text-ink-muted">{description}</p>}
                </div>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close"
                  className="-mt-1 -mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full"
                >
                  <X aria-hidden="true" className="size-5" />
                </button>
              </div>
              {children}
            </div>
          </TrayContext.Provider>
        )}
      </dialog>
    </>
  );
}
