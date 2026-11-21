import type { Block, PackageDocument } from "@/domain/packages/document";
import { cn } from "@/lib/cn";

function BlockView({ block, label }: { block: Block; label: string }) {
  if (block.type === "facts") {
    return (
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(0,14rem)_1fr]">
        {block.items.map((item, i) => (
          <div key={`${item.label}-${i}`} className="contents">
            <dt className="text-label-lg font-semibold text-ink-muted">{item.label}</dt>
            <dd className="text-body-md break-words">{item.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  if (block.type === "text") {
    return (
      <p
        className={cn(
          "text-body-md break-words",
          block.tone !== "plain" && "border-l-4 pl-3 italic text-ink-muted",
          block.tone === "caution" && "border-action-emphasis",
          block.tone === "note" && "border-action-secondary",
        )}
      >
        {block.tone === "caution" && <span className="font-semibold not-italic">Heads up: </span>}
        {block.tone === "note" && <span className="font-semibold not-italic">Note: </span>}
        {block.text}
      </p>
    );
  }
  return (
    <div
      role="region"
      aria-label={`${label}: ${block.caption}`}
      tabIndex={0}
      className="overflow-x-auto rounded-control border border-border-hairline"
    >
      <table className="w-full min-w-max text-left text-body-sm">
        <caption className="px-3 py-2 text-left text-label-lg font-semibold text-action-secondary">
          {block.caption}
        </caption>
        <thead className="bg-surface-muted">
          <tr>
            {block.columns.map((c, i) => (
              <th
                key={`${c}-${i}`}
                scope="col"
                className={cn(
                  "px-3 py-2 font-semibold",
                  block.align[i] === "right" && "text-right",
                )}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r} className="border-t border-border-hairline align-top">
              {row.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="px-3 py-2 font-normal">
                    {cell}
                  </th>
                ) : (
                  <td
                    key={i}
                    className={cn("px-3 py-2", block.align[i] === "right" && "text-right")}
                  >
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The exact document the renderers receive, shown as accessible HTML. */
export function PackageDocumentView({ doc }: { doc: PackageDocument }) {
  return (
    <div className="space-y-8">
      {doc.sections.map((s) => (
        <section key={s.id} aria-labelledby={`pkg-${s.id}`} className="space-y-4">
          <h3 id={`pkg-${s.id}`} className="font-serif text-headline-sm">
            {s.title}
          </h3>
          {s.blocks.map((b, i) => (
            <BlockView key={i} block={b} label={s.title} />
          ))}
        </section>
      ))}
    </div>
  );
}
