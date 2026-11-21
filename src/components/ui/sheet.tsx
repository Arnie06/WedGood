"use client";

import { X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from "react";
import { Button, type ButtonVariant } from "@/components/ui/button";

const SheetContext = createContext<{ close: () => void } | null>(null);

/** Lets a form inside a sheet close it after a successful save. Outside a sheet it does nothing. */
export function useSheetClose(): () => void {
  const ctx = useContext(SheetContext);
  return ctx ? ctx.close : () => undefined;
}

/**
 * A button that opens a bottom sheet on phones and a centred dialog on larger
 * screens. Built on the native <dialog>, so focus is trapped, Escape closes,
 * the page behind is inert, and focus returns to the button afterwards.
 */
export function SheetButton({
  label,
  title,
  description,
  variant = "primary",
  className,
  openOnParam,
  children,
}: {
  label: string;
  title: string;
  description?: string;
  variant?: ButtonVariant;
  className?: string;
  /** Opens on arrival when the URL has `?<name>=1` (used by the quick-add menu), then tidies the URL. */
  openOnParam?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  /** Opens modally, then puts focus in the first field (React's autoFocus runs while closed). */
  const openDialog = () => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select")?.focus();
  };
  const wanted = openOnParam ? params.get(openOnParam) === "1" : false;
  useEffect(() => {
    if (!wanted || !openOnParam) return;
    openDialog();
    const next = new URLSearchParams(params.toString());
    next.delete(openOnParam);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  const titleId = useId();
  const close = () => ref.current?.close();

  return (
    <>
      <Button type="button" variant={variant} className={className} onClick={openDialog}>
        {label}
      </Button>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        onClick={(event) => {
          // A click on the backdrop (the dialog element itself) dismisses it.
          if (event.target === event.currentTarget) close();
        }}
        className="fixed inset-x-0 top-auto bottom-0 m-0 max-h-[90dvh] w-full max-w-none overflow-y-auto rounded-t-card border border-border-hairline bg-surface p-0 text-ink shadow-ambient-sm backdrop:bg-ink/40 sm:inset-0 sm:m-auto sm:h-fit sm:max-w-lg sm:rounded-card"
      >
        <SheetContext.Provider value={{ close }}>
          <div className="space-y-4 p-5 sm:p-6">
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
        </SheetContext.Provider>
      </dialog>
    </>
  );
}
