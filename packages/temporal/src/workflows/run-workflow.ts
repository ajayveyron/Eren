import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep
} from "@temporalio/workflow";
import type {
  GrantDecision,
  PolicyMutationProposal,
  RunWorkflowInput,
  TurnResult
} from "@eren/domain";
import type { RunWorkflowActivities } from "../activities";

const activities = proxyActivities<RunWorkflowActivities>({
  startToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "1s",
    maximumInterval: "30s",
    backoffCoefficient: 2,
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["ApplicationError", "PolicyViolationError", "ValidationError"]
  }
});

export const pauseRunSignal = defineSignal("pauseRun");
export const resumeRunSignal = defineSignal("resumeRun");
export const operatorNoteSignal = defineSignal<[string]>("operatorNote");
export const grantDecisionSignal = defineSignal<[GrantDecision]>("grantDecision");

function shiftDecisionForProposal(
  queue: GrantDecision[],
  proposal: PolicyMutationProposal
): GrantDecision | null {
  const index = queue.findIndex((d) => d.requestId === proposal.mutationId);
  if (index === -1) return null;
  return queue.splice(index, 1)[0] ?? null;
}

async function applyGovernanceDecision(
  input: RunWorkflowInput,
  currentPolicyVersionId: string,
  proposal: PolicyMutationProposal,
  decisionQueue: GrantDecision[]
) {
  if (input.governanceMode === "read_only") {
    await activities.recordRunEvent({
      runId: input.runId,
      eventType: "policy.proposed",
      actorType: "agent",
      actorId: "eren",
      payload: proposal
    });

    return currentPolicyVersionId;
  }

  if (input.governanceMode === "supervised") {
    await activities.recordRunEvent({
      runId: input.runId,
      eventType: "approval.requested",
      actorType: "system",
      actorId: "temporal",
      payload: proposal
    });

    await activities.updateRunStatus({
      runId: input.runId,
      status: "waiting_on_approval",
      currentPolicyVersionId
    });

    await condition(() => decisionQueue.some((d) => d.requestId === proposal.mutationId));

    const matchedDecision = shiftDecisionForProposal(decisionQueue, proposal);

    if (!matchedDecision || matchedDecision.action === "deny") {
      await activities.recordRunEvent({
        runId: input.runId,
        eventType: "approval.denied",
        actorType: "operator",
        actorId: "human",
        payload: {
          mutationId: proposal.mutationId,
          reason: matchedDecision?.reason ?? "No reason provided."
        }
      });

      return currentPolicyVersionId;
    }

    const nextPolicy = await activities.applyPolicyMutation({
      runId: input.runId,
      policyVersionId: currentPolicyVersionId,
      governanceMode: input.governanceMode,
      proposal,
      approvedBy: "human",
      ttlOverrideSeconds: matchedDecision.ttlOverrideSeconds ?? null,
      scopeOverride: matchedDecision.scopeOverride ?? null
    });

    await activities.recordRunEvent({
      runId: input.runId,
      eventType: "approval.approved",
      actorType: "operator",
      actorId: "human",
      payload: {
        mutationId: proposal.mutationId,
        nextPolicyVersionId: nextPolicy.id
      }
    });

    return nextPolicy.id;
  }

  const nextPolicy = await activities.applyPolicyMutation({
    runId: input.runId,
    policyVersionId: currentPolicyVersionId,
    governanceMode: input.governanceMode,
    proposal,
    approvedBy: "eren",
    ttlOverrideSeconds: null,
    scopeOverride: null
  });

  await activities.recordRunEvent({
    runId: input.runId,
    eventType: "policy.applied",
    actorType: "agent",
    actorId: "eren",
    payload: {
      mutationId: proposal.mutationId,
      nextPolicyVersionId: nextPolicy.id
    }
  });

  return nextPolicy.id;
}

export async function runWorkflow(input: RunWorkflowInput) {
  let paused = false;
  let operatorNotes: string[] = [];
  let currentPolicyVersionId = input.initialPolicyVersionId;
  const decisionQueue: GrantDecision[] = [];

  setHandler(pauseRunSignal, () => {
    paused = true;
  });

  setHandler(resumeRunSignal, () => {
    paused = false;
  });

  setHandler(operatorNoteSignal, (note) => {
    operatorNotes.push(note);
  });

  setHandler(grantDecisionSignal, (decision) => {
    decisionQueue.push(decision);
  });

  await activities.recordRunEvent({
    runId: input.runId,
    eventType: "run.started",
    actorType: "system",
    actorId: "temporal",
    payload: {
      governanceMode: input.governanceMode,
      initialPolicyVersionId: input.initialPolicyVersionId
    }
  });

  await activities.updateRunStatus({
    runId: input.runId,
    status: "running",
    currentPolicyVersionId
  });

  for (let turnNumber = 1; turnNumber <= input.maxTurns; turnNumber += 1) {
    if (paused) {
      await activities.updateRunStatus({
        runId: input.runId,
        status: "paused",
        currentPolicyVersionId
      });

      await condition(() => !paused);

      await activities.updateRunStatus({
        runId: input.runId,
        status: "running",
        currentPolicyVersionId
      });
    }

    const policyVersion = await activities.loadPolicyVersion({
      policyVersionId: currentPolicyVersionId
    });

    const resolvedPolicy = await activities.resolveCapabilities({
      runId: input.runId,
      policyVersion
    });

    // Snapshot notes for this turn so notes arriving during execution are preserved.
    const turnNotes = [...operatorNotes];
    const result: TurnResult = await activities.runTurn({
      runId: input.runId,
      turnNumber,
      task: input.task,
      governanceMode: input.governanceMode,
      policyVersion,
      resolvedPolicy,
      operatorNotes: turnNotes
    });

    // Remove only the notes that were consumed by this turn.
    // Any notes pushed by the signal handler during runTurn remain.
    operatorNotes.splice(0, turnNotes.length);

    // Update status BEFORE saving turn result so there's no window where
    // the turn is persisted but the run status is stale.
    const derivedStatus =
      result.status === "failed"
        ? "failed" as const
        : result.status === "completed"
          ? "completed" as const
          : "running" as const;

    await activities.updateRunStatus({
      runId: input.runId,
      status: derivedStatus,
      currentPolicyVersionId
    });

    const savedTurn = await activities.saveTurnResult({
      runId: input.runId,
      turnNumber,
      policyVersionId: currentPolicyVersionId,
      result
    });

    await activities.recordRunEvent({
      runId: input.runId,
      turnId: savedTurn.id,
      eventType: "turn.completed",
      actorType: "agent",
      actorId: "eren",
      payload: {
        turnNumber,
        status: result.status,
        summary: result.summary,
        metrics: result.metrics
      }
    });

    for (const request of result.capabilityRequests) {
      await activities.recordRunEvent({
        runId: input.runId,
        turnId: savedTurn.id,
        eventType: "capability.requested",
        actorType: "agent",
        actorId: "eren",
        payload: request
      });
    }

    for (const proposal of result.policyMutations) {
      currentPolicyVersionId = await applyGovernanceDecision(
        input,
        currentPolicyVersionId,
        proposal,
        decisionQueue
      );
    }

    if (result.status === "completed") {
      await activities.recordRunEvent({
        runId: input.runId,
        eventType: "run.completed",
        actorType: "system",
        actorId: "temporal",
        payload: {
          turnNumber,
          finalSummary: result.summary,
          finalPolicyVersionId: currentPolicyVersionId
        }
      });

      return {
        status: "completed" as const,
        finalPolicyVersionId: currentPolicyVersionId,
        completedTurnNumber: turnNumber
      };
    }

    if (result.status === "failed") {
      await activities.recordRunEvent({
        runId: input.runId,
        eventType: "run.failed",
        actorType: "system",
        actorId: "temporal",
        payload: {
          turnNumber,
          finalSummary: result.summary
        }
      });

      return {
        status: "failed" as const,
        finalPolicyVersionId: currentPolicyVersionId,
        completedTurnNumber: turnNumber
      };
    }

    if (input.turnDelayMs > 0) {
      await sleep(input.turnDelayMs);
    }
  }

  await activities.recordRunEvent({
    runId: input.runId,
    eventType: "run.max_turns_reached",
    actorType: "system",
    actorId: "temporal",
    payload: {
      maxTurns: input.maxTurns,
      finalPolicyVersionId: currentPolicyVersionId
    }
  });

  await activities.updateRunStatus({
    runId: input.runId,
    status: "failed",
    currentPolicyVersionId
  });

  return {
    status: "blocked" as const,
    finalPolicyVersionId: currentPolicyVersionId,
    completedTurnNumber: input.maxTurns
  };
}
