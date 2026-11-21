"use client";

import { useTrayActionState } from "@/components/ui/tray";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { MOVABLE_STAGES, PIPELINE_STAGES, type PipelineStage } from "@/domain/proposals/stages";
import {
  archiveProposal,
  removeProposalLine,
  setCandidateStage,
  setProposalStatus,
  type ProposalActionState,
} from "@/server/proposals/actions";

const idle: ProposalActionState = { status: "idle" };

function Feedback({ state }: { state: ProposalActionState }) {
  return (
    <div aria-live="polite" className="min-h-6">
      {state.status === "error" && (
        <p role="alert" className="text-body-md text-danger">
          {state.message}
        </p>
      )}
      {state.status === "ok" && (
        <p className="text-body-md text-action-secondary">{state.message}</p>
      )}
    </div>
  );
}

/** Select plus an explicit button, so keyboard and screen-reader users never change stage by accident. */
export function StageForm({
  workspaceId,
  candidateId,
  version,
  stage,
}: {
  workspaceId: string;
  candidateId: string;
  version: number;
  stage: PipelineStage;
}) {
  const [state, action, pending] = useTrayActionState(setCandidateStage, idle);
  const reserved = stage === "booked" || stage === "cancelled";
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="candidateId" value={candidateId} />
      <input type="hidden" name="version" value={version} />
      <SelectField
        label="Where things stand"
        name="stage"
        defaultValue={stage}
        disabled={reserved}
        hint={
          reserved
            ? "Booking changes are made from the booking record."
            : "Move this along as you hear back. Booking is recorded separately, with its costs."
        }
        key={`${stage}-${version}`}
      >
        {PIPELINE_STAGES.filter((s) => MOVABLE_STAGES.includes(s.value) || s.value === stage).map(
          (s) => (
            <option key={s.value} value={s.value} disabled={!MOVABLE_STAGES.includes(s.value)}>
              {s.label}
            </option>
          ),
        )}
      </SelectField>
      <Button type="submit" variant="secondary" size="sm" disabled={pending || reserved}>
        {pending ? "Updating…" : "Update stage"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function ProposalStatusForm({
  workspaceId,
  proposalId,
  version,
  status,
}: {
  workspaceId: string;
  proposalId: string;
  version: number;
  status: "open" | "declined";
}) {
  const [state, action, pending] = useTrayActionState(setProposalStatus, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="proposalId" value={proposalId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="status" value={status === "open" ? "declined" : "open"} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {status === "open" ? "Mark this quote as passed" : "Reopen this quote"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function ArchiveProposalForm({
  workspaceId,
  candidateId,
  proposalId,
  version,
}: {
  workspaceId: string;
  candidateId: string;
  proposalId: string;
  version: number;
}) {
  const [state, action, pending] = useTrayActionState(archiveProposal, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="candidateId" value={candidateId} />
      <input type="hidden" name="proposalId" value={proposalId} />
      <input type="hidden" name="version" value={version} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Removing…" : "Remove this quote"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function RemoveLineForm({
  workspaceId,
  lineId,
  version,
  name,
}: {
  workspaceId: string;
  lineId: string;
  version: number;
  name: string;
}) {
  const [state, action, pending] = useTrayActionState(removeProposalLine, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="lineId" value={lineId} />
      <input type="hidden" name="version" value={version} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Removing…" : "Remove"}
        <span className="sr-only"> {name}</span>
      </Button>
      <Feedback state={state} />
    </form>
  );
}
