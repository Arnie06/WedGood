import { CircleAlert, Info } from "lucide-react";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { TrayButton } from "@/components/ui/tray";
import {
  SEVERITY_LABELS,
  attentionSummary,
  type AttentionItem,
} from "@/domain/attention/attention";
import type { HistoryLine } from "@/domain/attention/history";
import { AttentionButton } from "./attention-button";

/**
 * Needs attention: one list for everything the couple should look at (REL-10). Each row says what
 * and why in a sentence, carries its severity as a word and an icon (never colour alone), and links
 * straight to where it is fixed. Owner and partner can dismiss a computed item or mark a stored one
 * handled; nobody's action here changes the wedding itself.
 */
export function AttentionList({
  items,
  base,
  workspaceId,
  canAct,
  mode = "active",
  empty,
  testId = "attention-list",
  history,
}: {
  items: readonly AttentionItem[];
  base: string;
  workspaceId: string;
  canAct: boolean;
  /** "dismissed" rows get "Show again" instead of "Dismiss". */
  mode?: "active" | "dismissed";
  empty?: string;
  testId?: string;
  /** When given, each row gets a Details tray with what happened, a suggested fix and history (UX-12). */
  history?: { byKey: ReadonlyMap<string, readonly HistoryLine[]>; partial: boolean };
}) {
  if (items.length === 0) {
    return (
      <p className="text-body-md text-ink-muted" data-testid={`${testId}-empty`}>
        {empty ?? attentionSummary(0)}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border-hairline" data-testid={testId}>
      {items.map((item) => {
        const urgent = item.severity === "action";
        const Icon = urgent ? CircleAlert : Info;
        return (
          <li
            key={item.key}
            className="space-y-2 py-4 first:pt-0 last:pb-0"
            data-testid="attention-item"
            data-kind={item.kind}
          >
            <p className="flex items-start gap-2 text-body-lg font-semibold">
              <Icon
                aria-hidden="true"
                className={
                  urgent
                    ? "mt-1 size-4 shrink-0 text-danger"
                    : "mt-1 size-4 shrink-0 text-ink-muted"
                }
              />
              <span className="break-words">
                <span className="sr-only">{SEVERITY_LABELS[item.severity]}: </span>
                {item.title}
              </span>
            </p>
            <p className="text-body-md text-ink-muted">
              <span aria-hidden="true" className="font-semibold">
                {SEVERITY_LABELS[item.severity]}.
              </span>{" "}
              {item.detail} {item.fix}
            </p>
            <div className="flex flex-wrap items-center gap-x-2">
              <ButtonLink
                href={`${base}/${item.path}`}
                variant="outline"
                size="sm"
                aria-label={`${item.cta}: ${item.title}`}
              >
                {item.cta}
              </ButtonLink>
              {canAct && (
                <AttentionButton
                  workspaceId={workspaceId}
                  mode={mode === "dismissed" ? "restore" : item.storedId ? "handle" : "dismiss"}
                  itemTitle={item.title}
                  kind={item.kind}
                  subjectId={item.subjectId}
                  fingerprint={item.fingerprint}
                  storedId={item.storedId}
                />
              )}
              {history && (
                <TrayButton
                  label="Details"
                  variant="quiet"
                  size="sm"
                  ariaLabel={`Details: ${item.title}`}
                  title={item.title}
                  description={SEVERITY_LABELS[item.severity]}
                >
                  <AttentionDetail
                    item={item}
                    base={base}
                    workspaceId={workspaceId}
                    canAct={canAct}
                    mode={mode}
                    lines={history.byKey.get(item.key) ?? []}
                    partial={history.partial}
                  />
                </TrayButton>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The item drawer (W9): what happened, what it touches, a suggested fix, the same two actions as the
 * row, and the history read back from the activity record. Reading it changes nothing.
 */
function AttentionDetail({
  item,
  base,
  workspaceId,
  canAct,
  mode,
  lines,
  partial,
}: {
  item: AttentionItem;
  base: string;
  workspaceId: string;
  canAct: boolean;
  mode: "active" | "dismissed";
  lines: readonly HistoryLine[];
  partial: boolean;
}) {
  return (
    <div className="space-y-5" data-testid="attention-detail">
      <dl className="space-y-3">
        {(
          [
            ["What happened", item.detail],
            ["Touches", item.touches],
            ["Suggested fix", item.fix],
          ] as const
        ).map(([term, text]) => (
          <div key={term}>
            <dt className="text-label-lg font-semibold">{term}</dt>
            <dd className="text-body-md text-ink-muted">{text}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <ButtonLink href={`${base}/${item.path}`} size="sm">
          {item.cta}
        </ButtonLink>
        {canAct && (
          <AttentionButton
            workspaceId={workspaceId}
            mode={mode === "dismissed" ? "restore" : item.storedId ? "handle" : "dismiss"}
            itemTitle={item.title}
            kind={item.kind}
            subjectId={item.subjectId}
            fingerprint={item.fingerprint}
            storedId={item.storedId}
          />
        )}
      </div>
      <section aria-labelledby={`history-${item.key}`} className="space-y-2">
        <h3 id={`history-${item.key}`} className="text-label-lg font-semibold">
          History
        </h3>
        {lines.length === 0 ? (
          <p className="text-body-md text-ink-muted" data-testid="attention-history-empty">
            {item.storedId === null
              ? "Worked out from your plans each time you look. Nobody has dismissed it."
              : "Nothing recorded yet."}
          </p>
        ) : (
          <ol className="space-y-1 text-body-md text-ink-muted" data-testid="attention-history">
            {lines.map((line, i) => (
              <li key={`${line.at}-${i}`}>{line.text}</li>
            ))}
          </ol>
        )}
        {partial && (
          <p className="text-body-sm text-ink-muted">
            Who did what is shown to the owner and partners.
          </p>
        )}
      </section>
    </div>
  );
}

/** Footer of the Home card: a link to the full list when more than a few, or some are hidden. */
export function SeeAllLink({
  base,
  total,
  shown,
  hidden,
}: {
  base: string;
  total: number;
  shown: number;
  hidden: number;
}) {
  const parts = [
    total > shown ? `See all ${total}` : null,
    hidden > 0 ? `${hidden} hidden` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p className="mt-3">
      <Link
        href={`${base}/plan/attention`}
        className="inline-flex min-h-11 items-center font-semibold text-action-emphasis underline underline-offset-4"
      >
        {parts.join(" · ")}
      </Link>
    </p>
  );
}
