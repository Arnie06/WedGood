import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { categoryLabel } from "@/domain/candidates/categories";
import { stageLabel } from "@/domain/proposals/stages";
import { displayHost } from "@/domain/candidates/input";
import type { CandidateRecord } from "@/server/candidates/queries";
import { FavoriteButton } from "./candidate-actions";
import { priceLabel, sourceLabel } from "./format";

export function CandidateCard({
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
    <Card as="li" className="flex items-start gap-3 p-4 sm:p-4">
      <FavoriteButton
        workspaceId={workspaceId}
        candidateId={c.id}
        name={c.name}
        favorite={c.isFavorite}
        disabled={!canManage}
      />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-serif text-headline-sm break-words">
            <Link href={`${base}/discover/${c.id}`} className="underline-offset-4 hover:underline">
              {c.name}
            </Link>
          </h3>
          <Badge tone="neutral">{categoryLabel(c.category)}</Badge>
          {c.stage !== "saved" && (
            <Badge tone={c.stage === "declined" ? "neutral" : "pending"}>
              {stageLabel(c.stage)}
            </Badge>
          )}
        </div>
        {c.location && <p className="text-body-md text-ink-muted">{c.location}</p>}
        <p className="text-body-md">
          {price ?? "Price not entered yet"}
          {capacity.length > 0 ? ` · ${capacity.join(" · ")}` : ""}
          {c.kind === "venue" && capacity.length === 0 ? " · Capacity not entered yet" : ""}
        </p>
        {c.pricingDisplay && <p className="text-body-sm text-ink-muted">{c.pricingDisplay}</p>}
        <p className="text-body-sm text-ink-muted">
          {sourceLabel(c.sourceUrl, c.sourceCheckedOn)}
          {c.sourceUrl && (
            <>
              {" · "}
              <a
                href={c.sourceUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="font-semibold text-action-emphasis underline underline-offset-4"
              >
                {displayHost(c.sourceUrl)}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </>
          )}
        </p>
      </div>
    </Card>
  );
}
