import { z } from "zod";

export const capabilityClasses = [
  "read",
  "write",
  "network",
  "browser",
  "scheduler",
  "worker",
  "deployment",
  "secrets",
  "meta-governance"
] as const;

export const governanceModes = [
  "open",
  "supervised",
  "read_only"
] as const;

export const riskLevels = ["low", "medium", "high", "critical"] as const;
export const costClasses = ["cheap", "metered", "expensive"] as const;
export const bindingTypes = ["global", "tool", "service"] as const;
export const grantTypes = ["permanent", "session", "lease"] as const;
export const runStatuses = [
  "queued",
  "running",
  "waiting_on_approval",
  "paused",
  "completed",
  "failed",
  "cancelled"
] as const;
export const turnStatuses = [
  "running",
  "waiting_on_approval",
  "completed",
  "failed",
  "cancelled"
] as const;
export const turnResultStatuses = ["continue", "blocked", "completed", "failed"] as const;
export const decisionActions = ["approve", "deny", "modify"] as const;

export const capabilityClassSchema = z.enum(capabilityClasses);
export const governanceModeSchema = z.enum(governanceModes);
export const riskLevelSchema = z.enum(riskLevels);
export const costClassSchema = z.enum(costClasses);
export const bindingTypeSchema = z.enum(bindingTypes);
export const grantTypeSchema = z.enum(grantTypes);
export const runStatusSchema = z.enum(runStatuses);
export const turnStatusSchema = z.enum(turnStatuses);
export const turnResultStatusSchema = z.enum(turnResultStatuses);
export const decisionActionSchema = z.enum(decisionActions);

export type CapabilityClass = z.infer<typeof capabilityClassSchema>;
export type GovernanceMode = z.infer<typeof governanceModeSchema>;
export type RiskLevel = z.infer<typeof riskLevelSchema>;
export type CostClass = z.infer<typeof costClassSchema>;
export type BindingType = z.infer<typeof bindingTypeSchema>;
export type GrantType = z.infer<typeof grantTypeSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type TurnStatus = z.infer<typeof turnStatusSchema>;
export type TurnResultStatus = z.infer<typeof turnResultStatusSchema>;
export type DecisionAction = z.infer<typeof decisionActionSchema>;

const scopeSchema = z.record(z.string(), z.unknown()).default({});

export const capabilityDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  capabilityClass: capabilityClassSchema,
  bindingType: bindingTypeSchema,
  bindingSource: z.string(),
  riskLevel: riskLevelSchema,
  costClass: costClassSchema,
  defaultScope: scopeSchema,
  defaultTTLSeconds: z.number().int().positive().nullable(),
  dependencies: z.array(z.string()).default([]),
  sideEffects: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([])
});

export const capabilityGrantSchema = z.object({
  id: z.string(),
  capabilityId: z.string(),
  grantType: grantTypeSchema,
  grantedBy: z.string(),
  reason: z.string(),
  scope: scopeSchema,
  ttlSeconds: z.number().int().positive().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable()
});

export const policyVersionSchema = z.object({
  id: z.string(),
  familyId: z.string(),
  versionNumber: z.number().int().positive(),
  governanceMode: governanceModeSchema,
  enabledCapabilityIds: z.array(z.string()),
  grants: z.array(capabilityGrantSchema),
  reason: z.string(),
  createdBy: z.string(),
  createdAt: z.string()
});

export const agentDefinedCapabilitySchema = z.object({
  id: z.string(),
  runId: z.string(),
  name: z.string(),
  description: z.string(),
  parameterSchema: z.record(z.string(), z.unknown()),
  scriptPath: z.string(),
  scriptLanguage: z.enum(["node", "python3", "bash"]),
  riskLevel: riskLevelSchema.default("high"),
  status: z.enum(["pending", "approved", "denied"]).default("pending"),
  definedBy: z.string().default("eren"),
  approvedBy: z.string().nullable().default(null),
  createdAt: z.string()
});

export const saveAgentDefinedCapabilityInputSchema = z.object({
  runId: z.string(),
  name: z.string().min(1),
  description: z.string().min(1),
  parameterSchema: z.record(z.string(), z.unknown()),
  scriptPath: z.string().min(1),
  scriptLanguage: z.enum(["node", "python3", "bash"]),
  status: z.enum(["pending", "approved"]).default("pending"),
  approvedBy: z.string().nullable().default(null)
});

export const resolvedPolicySchema = z.object({
  policyVersion: policyVersionSchema,
  resolvedCapabilities: z.array(capabilityDefinitionSchema),
  agentDefinedCapabilities: z.array(agentDefinedCapabilitySchema).default([]),
  expiresAtByCapabilityId: z.record(z.string(), z.string().nullable()).default({})
});

export const artifactRefSchema = z.object({
  id: z.string(),
  kind: z.string(),
  pathOrUrl: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const runActionSchema = z.object({
  type: z.string(),
  description: z.string()
});

export const capabilityRequestSchema = z.object({
  requestId: z.string(),
  capabilityId: z.string(),
  reason: z.string(),
  expectedBenefit: z.string(),
  fallbackIfDenied: z.string(),
  requestedScope: scopeSchema,
  requestedTTLSeconds: z.number().int().positive().nullable()
});

export const policyMutationProposalSchema = z.object({
  mutationId: z.string(),
  kind: z.enum(["grant", "revoke", "replace_scope"]),
  capabilityId: z.string(),
  reason: z.string(),
  requestedScope: scopeSchema,
  requestedTTLSeconds: z.number().int().positive().nullable()
});

export const delegationRequestSchema = z.object({
  requestId: z.string(),
  objective: z.string(),
  specialistRole: z.string(),
  policyHints: z.array(z.string()).default([])
});

export const turnMetricsSchema = z.object({
  toolCalls: z.number().int().nonnegative(),
  capabilityRequests: z.number().int().nonnegative(),
  policyMutations: z.number().int().nonnegative(),
  artifactsProduced: z.number().int().nonnegative(),
  turnDurationMs: z.number().int().nonnegative(),
  metaGovernanceRatio: z.number().min(0).max(1)
});

export const turnResultSchema = z.object({
  status: turnResultStatusSchema,
  summary: z.string(),
  intent: z.string(),
  currentBlockers: z.array(z.string()).default([]),
  actions: z.array(runActionSchema).default([]),
  capabilityRequests: z.array(capabilityRequestSchema).default([]),
  policyMutations: z.array(policyMutationProposalSchema).default([]),
  delegationRequests: z.array(delegationRequestSchema).default([]),
  artifacts: z.array(artifactRefSchema).default([]),
  metrics: turnMetricsSchema,
  deliverable: z.string().default("")
});

export const runRecordSchema = z.object({
  id: z.string(),
  task: z.string(),
  status: runStatusSchema,
  governanceMode: governanceModeSchema,
  initialPolicyVersionId: z.string(),
  currentPolicyVersionId: z.string(),
  workflowId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable()
});

export const runTurnSchema = z.object({
  id: z.string(),
  runId: z.string(),
  turnNumber: z.number().int().positive(),
  policyVersionId: z.string(),
  status: turnStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  intent: z.string(),
  blockers: z.array(z.string()).default([]),
  summary: z.string(),
  deliverable: z.string().default(""),
  metrics: turnMetricsSchema
});

export const runEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  turnId: z.string().nullable(),
  eventType: z.string(),
  actorType: z.enum(["system", "agent", "operator", "subagent"]),
  actorId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string()
});

export const grantDecisionSchema = z.object({
  requestId: z.string(),
  action: decisionActionSchema,
  reason: z.string().optional(),
  ttlOverrideSeconds: z.number().int().positive().optional(),
  scopeOverride: z.record(z.string(), z.unknown()).optional()
});

export const runWorkflowInputSchema = z.object({
  runId: z.string(),
  task: z.string(),
  governanceMode: governanceModeSchema,
  initialPolicyVersionId: z.string(),
  maxTurns: z.number().int().positive().default(12),
  turnDelayMs: z.number().int().nonnegative().default(0)
});

export const createRunInputSchema = z.object({
  task: z.string().min(1),
  governanceMode: governanceModeSchema.default("supervised"),
  initialPolicyVersionId: z.string(),
  maxTurns: z.number().int().positive().default(12),
  turnDelayMs: z.number().int().nonnegative().default(0)
});

export const loadPolicyVersionInputSchema = z.object({
  policyVersionId: z.string()
});

export const resolveCapabilitiesInputSchema = z.object({
  runId: z.string(),
  policyVersion: policyVersionSchema
});

export const runTurnInputSchema = z.object({
  runId: z.string(),
  turnNumber: z.number().int().positive(),
  task: z.string(),
  governanceMode: governanceModeSchema,
  policyVersion: policyVersionSchema,
  resolvedPolicy: resolvedPolicySchema,
  operatorNotes: z.array(z.string()).default([])
});

export const applyPolicyMutationInputSchema = z.object({
  runId: z.string(),
  policyVersionId: z.string(),
  governanceMode: governanceModeSchema,
  proposal: policyMutationProposalSchema,
  approvedBy: z.string(),
  ttlOverrideSeconds: z.number().int().positive().nullable().default(null),
  scopeOverride: z.record(z.string(), z.unknown()).nullable().default(null)
});

export const persistTurnResultInputSchema = z.object({
  runId: z.string(),
  turnNumber: z.number().int().positive(),
  policyVersionId: z.string(),
  result: turnResultSchema
});

export const updateRunStatusInputSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  currentPolicyVersionId: z.string().optional(),
  endedAt: z.string().nullable().optional()
});

export const recordRunEventInputSchema = z.object({
  eventId: z.string().optional(),
  runId: z.string(),
  turnId: z.string().nullable().optional(),
  eventType: z.string(),
  actorType: z.enum(["system", "agent", "operator", "subagent"]),
  actorId: z.string(),
  payload: z.record(z.string(), z.unknown())
});

export const pendingCapabilityRequestSchema = z.object({
  requestId: z.string(),
  capabilityId: z.string(),
  reason: z.string(),
  fallbackIfDenied: z.string()
});

export const missionControlSnapshotSchema = z.object({
  run: runRecordSchema,
  activePolicy: policyVersionSchema,
  currentObjective: z.string(),
  latestDeliverable: z.string().nullable().default(null),
  dormantCapabilities: z.array(capabilityDefinitionSchema),
  pendingRequests: z.array(pendingCapabilityRequestSchema),
  recentTurns: z.array(runTurnSchema),
  recentEvents: z.array(runEventSchema)
});

export type CapabilityDefinition = z.infer<typeof capabilityDefinitionSchema>;
export type CapabilityGrant = z.infer<typeof capabilityGrantSchema>;
export type PolicyVersion = z.infer<typeof policyVersionSchema>;
export type ResolvedPolicy = z.infer<typeof resolvedPolicySchema>;
export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export type RunAction = z.infer<typeof runActionSchema>;
export type CapabilityRequest = z.infer<typeof capabilityRequestSchema>;
export type PolicyMutationProposal = z.infer<typeof policyMutationProposalSchema>;
export type DelegationRequest = z.infer<typeof delegationRequestSchema>;
export type TurnMetrics = z.infer<typeof turnMetricsSchema>;
export type TurnResult = z.infer<typeof turnResultSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type RunTurn = z.infer<typeof runTurnSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type GrantDecision = z.infer<typeof grantDecisionSchema>;
export type RunWorkflowInput = z.infer<typeof runWorkflowInputSchema>;
export type CreateRunInput = z.infer<typeof createRunInputSchema>;
export type LoadPolicyVersionInput = z.infer<typeof loadPolicyVersionInputSchema>;
export type ResolveCapabilitiesInput = z.infer<typeof resolveCapabilitiesInputSchema>;
export type RunTurnInput = z.infer<typeof runTurnInputSchema>;
export type ApplyPolicyMutationInput = z.infer<typeof applyPolicyMutationInputSchema>;
export type PersistTurnResultInput = z.infer<typeof persistTurnResultInputSchema>;
export type UpdateRunStatusInput = z.infer<typeof updateRunStatusInputSchema>;
export type RecordRunEventInput = z.infer<typeof recordRunEventInputSchema>;
export type PendingCapabilityRequest = z.infer<typeof pendingCapabilityRequestSchema>;
export type MissionControlSnapshot = z.infer<typeof missionControlSnapshotSchema>;
export type AgentDefinedCapability = z.infer<typeof agentDefinedCapabilitySchema>;
export type SaveAgentDefinedCapabilityInput = z.infer<typeof saveAgentDefinedCapabilityInputSchema>;
