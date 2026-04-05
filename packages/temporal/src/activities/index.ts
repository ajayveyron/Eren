import type {
  ApplyPolicyMutationInput,
  LoadPolicyVersionInput,
  PolicyVersion,
  PersistTurnResultInput,
  RecordRunEventInput,
  ResolveCapabilitiesInput,
  ResolvedPolicy,
  RunTurnInput,
  RunTurn,
  TurnResult,
  UpdateRunStatusInput
} from "@eren/domain";
import { createRepository } from "@eren/persistence";
import { runAgentTurn } from "../runtime/agent";

export interface RunWorkflowActivities {
  loadPolicyVersion(input: LoadPolicyVersionInput): Promise<PolicyVersion>;
  resolveCapabilities(input: ResolveCapabilitiesInput): Promise<ResolvedPolicy>;
  runTurn(input: RunTurnInput): Promise<TurnResult>;
  saveTurnResult(input: PersistTurnResultInput): Promise<RunTurn>;
  updateRunStatus(input: UpdateRunStatusInput): Promise<void>;
  applyPolicyMutation(input: ApplyPolicyMutationInput): Promise<PolicyVersion>;
  recordRunEvent(input: RecordRunEventInput): Promise<void>;
}

export function createRunWorkflowActivities(): RunWorkflowActivities {
  const repository = createRepository();

  return {
    async loadPolicyVersion(input) {
      return repository.loadPolicyVersion(input.policyVersionId);
    },

    async resolveCapabilities(input) {
      return repository.resolveCapabilities(input);
    },

    async runTurn(input) {
      let eventIndex = 0;

      return runAgentTurn(input, {
        onEvent: async (event) => {
          eventIndex += 1;

          await repository.recordRunEvent({
            eventId: `${input.runId}-turn-${input.turnNumber}-stream-${String(eventIndex).padStart(3, "0")}`,
            runId: input.runId,
            eventType: event.eventType,
            actorType: event.actorType ?? "agent",
            actorId: event.actorId ?? "eren",
            payload: {
              turnNumber: input.turnNumber,
              ...event.payload
            }
          });
        },
        onDefineCapability: async (capInput) => {
          return repository.saveAgentDefinedCapability(capInput);
        }
      });
    },

    async saveTurnResult(input) {
      return repository.saveTurnResult(input);
    },

    async updateRunStatus(input) {
      return repository.updateRunStatus(input);
    },

    async applyPolicyMutation(input) {
      return repository.applyPolicyMutation(input);
    },

    async recordRunEvent(input) {
      return repository.recordRunEvent(input);
    }
  };
}

export const activities = createRunWorkflowActivities();
