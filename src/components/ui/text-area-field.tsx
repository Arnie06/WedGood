import { CircleAlert } from "lucide-react";
import { useId, type ComponentProps } from "react";
import { cn } from "@/lib/cn";

type TextAreaFieldProps = Omit<ComponentProps<"textarea">, "id"> & {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
};

/** Labelled multi-line input mirroring TextField. */
export function TextAreaField({
  label,
  hint,
  error,
  className,
  required,
  ...props
}: TextAreaFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-label-lg font-semibold text-ink">
        {label}
        {required && <span className="font-normal text-ink-muted"> (required)</span>}
      </label>
      {hint && (
        <p id={hintId} className="text-body-sm text-ink-muted">
          {hint}
        </p>
      )}
      <textarea
        id={id}
        required={required}
        rows={3}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          "block min-h-24 w-full rounded-control border bg-surface-sunken px-4 py-3 text-body-md text-ink placeholder:text-ink-muted placeholder:italic",
          "focus-visible:border-focus",
          error ? "border-danger" : "border-border-control",
        )}
        {...props}
      />
      {error && (
        <p id={errorId} className="flex items-start gap-1.5 text-body-sm text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
