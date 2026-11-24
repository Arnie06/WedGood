import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { categoryLabel } from "@/domain/candidates/categories";
import { stageLabel } from "@/domain/proposals/stages";
import { displayHost } from "@/domain/candidates/input";
import type { CandidateRecord } from "@/server/candidates/queries";
import { FavoriteButton } from "./candidate-actions";
import { priceLabel, sourceLabel } from "./format";

export function CandidateRow({
  candidate: c,
  workspaceId,
  base,
  currency,
  canManage,
}: {
  candidate: CandidateRecord;
  workspaceId: string;
  base: string;
  currency: string;
  canManage: boolean;
}) {
  const price = priceLabel(c.priceMinor, c.priceBasis, c.priceCurrency ?? currency);
  const capacity = [
    c.seatedCapacity !== null ? `Seats ${c.seatedCapacity}` : null,
    c.ceremonyCapacity !== null ? `Ceremony ${c.ceremonyCapacity}` : null,
  ].filter((x): x is string => x !== null);
  return (
    <li className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-2 px-3 py-3 sm:gap-x-3 sm:px-4 lg:grid-cols-[2.75rem_minmax(0,2fr)_minmax(0,1.35fr)_minmax(0,1fr)] lg:items-center lg:gap-x-4">
      <FavoriteButton
        workspaceId={workspaceId}
        candidateId={c.id}
        name={c.name}
        favorite={c.isFavorite}
        disabled={!canManage}
      />
      <div className="min-w-0 space-y-1">
        <h3 className="min-w-0 font-semibold wrap-anywhere">
          <Link
            href={`${base}/discover/${c.id}`}
            className="inline-flex min-h-11 items-center rounded-hairline text-action-emphasis underline underline-offset-4"
          >
            {c.name}
          </Link>
        </h3>
        <p className="text-body-sm wrap-anywhere text-ink-muted">
          {categoryLabel(c.category)}
          {c.location && ` · ${c.location}`}
        </p>
        {c.stage !== "saved" && (
          <Badge tone={c.stage === "declined" ? "neutral" : "pending"}>{stageLabel(c.stage)}</Badge>
        )}
      </div>
      <div className="col-start-2 min-w-0 space-y-0.5 wrap-anywhere lg:col-start-auto">
        <p className="text-body-sm font-semibold tabular-nums">
          {price ?? "Price not entered yet"}
        </p>
        {capacity.length > 0 ? (
          <p className="text-body-sm text-ink-muted">{capacity.join(" · ")}</p>
        ) : c.kind === "venue" ? (
          <p className="text-body-sm text-ink-muted">Capacity not entered yet</p>
        ) : null}
        {c.pricingDisplay && <p className="text-body-sm text-ink-muted">{c.pricingDisplay}</p>}
      </div>
      <div className="col-start-2 min-w-0 text-body-sm wrap-anywhere text-ink-muted lg:col-start-auto">
        <p>{sourceLabel(c.sourceUrl, c.sourceCheckedOn)}</p>
        {c.sourceUrl && (
          <a
            href={c.sourceUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex min-h-11 items-center rounded-hairline font-semibold text-action-emphasis underline underline-offset-4"
          >
            <span className="min-w-0">{displayHost(c.sourceUrl)}</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </div>
    </li>
  );
}
