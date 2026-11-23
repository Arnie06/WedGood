import type { AnswerSummary } from "@/domain/guests/rsvp-form";

/**
 * What guests answered to the couple's questions for one event (UX-11): counts for yes/no and
 * choices, and each short answer with who gave it. Only people currently attending are counted.
 */
export function RsvpAnswers({
  summaries,
  hiddenCount,
}: {
  summaries: AnswerSummary[];
  /** Stored answers not shown: from people no longer attending, or to questions no longer asked. */
  hiddenCount: number;
}) {
  return (
    <div className="space-y-5">
      <p className="text-body-sm text-ink-muted">
        From people attending. Answers aren&apos;t used anywhere else in your workspace: change a
        meal, seat or guest detail yourself if an answer calls for it.
      </p>
      {summaries.map((s) => (
        <section key={s.key} className="space-y-2" aria-label={s.label}>
          <h3 className="text-label-lg font-semibold">{s.label}</h3>
          <p className="text-body-sm text-ink-muted">
            {s.answered === 0
              ? "No answers yet."
              : `${s.answered} ${s.answered === 1 ? "answer" : "answers"}`}
          </p>
          {s.tallies.length > 0 && (
            <ul className="space-y-1 text-body-md">
              {s.tallies.map((t) => (
                <li key={t.label} className="flex justify-between gap-4">
                  <span>{t.label}</span>
                  <span className="font-semibold tabular-nums">{t.count}</span>
                </li>
              ))}
            </ul>
          )}
          {s.texts.length > 0 && (
            <ul className="divide-y divide-border-hairline rounded-card border border-border-hairline">
              {s.texts.map((t, i) => (
                <li key={i} className="space-y-0.5 px-3 py-2">
                  <p className="text-body-sm font-semibold">{t.name}</p>
                  <p className="text-body-md break-words whitespace-pre-line">{t.text}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {hiddenCount > 0 && (
        <p className="text-body-sm text-ink-muted">
          {hiddenCount} more {hiddenCount === 1 ? "answer is" : "answers are"} kept but not shown:
          from people no longer attending, or to questions you no longer ask.
        </p>
      )}
    </div>
  );
}
