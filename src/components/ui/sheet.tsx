"use client";

import { X } from "lucide-react";
import { createContext, useContext, useId, useRef, type ReactNode } from "react";
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
  children,
}: {
  label: string;
  title: string;
  description?: string;
  variant?: ButtonVariant;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = () => ref.current?.close();

  return (
    <>
      <Button
        type="button"
        variant={variant}
        className={className}
        onClick={() => ref.current?.showModal()}
      >
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
