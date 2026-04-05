import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { Pool as PostgresPool } from "pg";
import type {
  AgentDefinedCapability,
  ApplyPolicyMutationInput,
  CapabilityDefinition,
  CapabilityGrant,
  CreateRunInput,
  MissionControlSnapshot,
  PendingCapabilityRequest,
  PersistTurnResultInput,
  PolicyVersion,
  RecordRunEventInput,
  ResolvedPolicy,
  ResolveCapabilitiesInput,
  RunEvent,
  RunRecord,
  RunTurn,
  SaveAgentDefinedCapabilityInput,
  UpdateRunStatusInput
} from "@eren/domain";
import { demoPolicyVersions, demoRunSnapshot } from "./seed";

type RowValue = string | number | boolean | null | Record<string, unknown> | unknown[];

export interface ErenRepository {
  createRun(input: CreateRunInput): Promise<RunRecord>;
  getMissionControlSnapshot(runId: string): Promise<MissionControlSnapshot>;
  listRuns(limit?: number, offset?: number): Promise<RunRecord[]>;
  listPolicyVersions(limit?: number, offset?: number): Promise<PolicyVersion[]>;
  loadPolicyVersion(policyVersionId: string): Promise<PolicyVersion>;
  resolveCapabilities(input: ResolveCapabilitiesInput): Promise<ResolvedPolicy>;
  saveTurnResult(input: PersistTurnResultInput): Promise<RunTurn>;
  updateRunStatus(input: UpdateRunStatusInput): Promise<void>;
  recordRunEvent(input: RecordRunEventInput): Promise<void>;
  applyPolicyMutation(input: ApplyPolicyMutationInput): Promise<PolicyVersion>;
  saveAgentDefinedCapability(input: SaveAgentDefinedCapabilityInput): Promise<AgentDefinedCapability>;
}

type CapabilityRow = {
  id: string;
  name: string;
  description: string;
  capability_class: CapabilityDefinition["capabilityClass"];
  binding_type: CapabilityDefinition["bindingType"];
  binding_source: string;
  risk_level: CapabilityDefinition["riskLevel"];
  cost_class: CapabilityDefinition["costClass"];
  default_scope: Record<string, unknown>;
  default_ttl_seconds: number | null;
  dependencies_json: string[];
  side_effects_json: string[];
  tags: string[];
};

type PolicyVersionRow = {
  id: string;
  policy_family_id: string;
  version_number: number;
  governance_mode: PolicyVersion["governanceMode"];
  policy_json: {
    enabledCapabilityIds: string[];
  };
  created_by: string;
  reason: string;
  created_at: string;
};

type PolicyGrantRow = {
  id: string;
  capability_id: string;
  grant_type: CapabilityGrant["grantType"];
  granted_by: string;
  reason: string;
  scope_json: Record<string, unknown>;
  ttl_seconds: number | null;
  created_at: string;
  expires_at: string | null;
};

type RunRow = {
  id: string;
  task: string;
  status: RunRecord["status"];
  governance_mode: RunRecord["governanceMode"];
  initial_policy_version_id: string;
  current_policy_version_id: string;
  workflow_id: string;
  started_at: string;
  ended_at: string | null;
};

type RunTurnRow = {
  id: string;
  run_id: string;
  turn_number: number;
  policy_version_id: string;
  status: RunTurn["status"];
  started_at: string;
  ended_at: string | null;
  intent: string;
  blockers_json: string[];
  summary: string;
  deliverable: string | null;
  metrics_json: RunTurn["metrics"];
};

type RunEventRow = {
  id: string;
  run_id: string;
  turn_id: string | null;
  event_type: string;
  actor_type: RunEvent["actorType"];
  actor_id: string;
  payload_json: Record<string, unknown>;
  created_at: string;
};

function mapCapabilityRow(row: CapabilityRow): CapabilityDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    capabilityClass: row.capability_class,
    bindingType: row.binding_type,
    bindingSource: row.binding_source,
    riskLevel: row.risk_level,
    costClass: row.cost_class,
    defaultScope: row.default_scope ?? {},
    defaultTTLSeconds: row.default_ttl_seconds,
    dependencies: row.dependencies_json ?? [],
    sideEffects: row.side_effects_json ?? [],
    tags: row.tags ?? []
  };
}

function mapGrantRow(row: PolicyGrantRow): CapabilityGrant {
  return {
    id: row.id,
    capabilityId: row.capability_id,
    grantType: row.grant_type,
    grantedBy: row.granted_by,
    reason: row.reason,
    scope: row.scope_json ?? {},
    ttlSeconds: row.ttl_seconds,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null
  };
}

function mapPolicyRow(row: PolicyVersionRow, grants: CapabilityGrant[]): PolicyVersion {
  return {
    id: row.id,
    familyId: row.policy_family_id,
    versionNumber: row.version_number,
    governanceMode: row.governance_mode,
    enabledCapabilityIds: row.policy_json.enabledCapabilityIds,
    grants,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function mapRunRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    task: row.task,
    status: row.status,
    governanceMode: row.governance_mode,
    initialPolicyVersionId: row.initial_policy_version_id,
    currentPolicyVersionId: row.current_policy_version_id,
    workflowId: row.workflow_id,
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null
  };
}

function mapTurnRow(row: RunTurnRow): RunTurn {
  return {
    id: row.id,
    runId: row.run_id,
    turnNumber: row.turn_number,
    policyVersionId: row.policy_version_id,
    status: row.status,
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    intent: row.intent,
    blockers: row.blockers_json ?? [],
    summary: row.summary,
    deliverable: row.deliverable ?? "",
    metrics: row.metrics_json
  };
}

function mapEventRow(row: RunEventRow): RunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    turnId: row.turn_id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    payload: row.payload_json ?? {},
    createdAt: new Date(row.created_at).toISOString()
  };
}

function hashPolicy(enabledCapabilityIds: string[], grants: CapabilityGrant[]) {
  return createHash("sha256")
    .update(JSON.stringify({ enabledCapabilityIds, grants }))
    .digest("hex");
}

function ensureCapabilityEnabled(
  enabledCapabilityIds: string[],
  capabilityId: string,
  shouldEnable: boolean
) {
  if (shouldEnable && !enabledCapabilityIds.includes(capabilityId)) {
    enabledCapabilityIds.push(capabilityId);
  }

  return enabledCapabilityIds.filter((value, index, array) => array.indexOf(value) === index);
}

function nextGrantFromMutation(input: ApplyPolicyMutationInput): CapabilityGrant {
  const now = new Date().toISOString();
  const ttlSeconds = input.ttlOverrideSeconds ?? input.proposal.requestedTTLSeconds ?? null;
  const expiresAt =
    ttlSeconds === null ? null : new Date(Date.now() + ttlSeconds * 1000).toISOString();

  return {
    id: `grant-${randomUUID()}`,
    capabilityId: input.proposal.capabilityId,
    grantType:
      ttlSeconds === null ? "permanent" : "session",
    grantedBy: input.approvedBy,
    reason: input.proposal.reason,
    scope: input.scopeOverride ?? input.proposal.requestedScope,
    ttlSeconds,
    createdAt: now,
    expiresAt
  };
}

function turnStatusFromResult(input: PersistTurnResultInput): RunTurn["status"] {
  if (input.result.status === "failed") {
    return "failed";
  }

  if (input.result.status === "blocked" || input.result.policyMutations.length > 0) {
    return "waiting_on_approval";
  }

  return "completed";
}

function makeTurnId(runId: string, turnNumber: number) {
  return `${runId}-turn-${turnNumber}`;
}

class DemoRepository implements ErenRepository {
  private run = { ...demoRunSnapshot.run };
  private policies = new Map<string, PolicyVersion>(
    demoPolicyVersions.map((policy) => [policy.id, policy])
  );
  private events = [...demoRunSnapshot.recentEvents];
  private turns = [...demoRunSnapshot.recentTurns];

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const id = `run-${randomUUID()}`;
    const workflowId = `eren-run-${randomUUID()}`;
    const now = new Date().toISOString();

    const newRun: RunRecord = {
      id,
      task: input.task,
      status: "queued",
      governanceMode: input.governanceMode,
      initialPolicyVersionId: input.initialPolicyVersionId,
      currentPolicyVersionId: input.initialPolicyVersionId,
      workflowId,
      startedAt: now,
      endedAt: null
    };

    this.run = newRun;
    return newRun;
  }

  async listRuns(limit: number = 20, offset: number = 0): Promise<RunRecord[]> {
    return [this.run].slice(offset, offset + limit);
  }

  async listPolicyVersions(limit: number = 20, offset: number = 0): Promise<PolicyVersion[]> {
    return [...this.policies.values()]
      .sort((left, right) => right.versionNumber - left.versionNumber)
      .slice(offset, offset + limit);
  }

  async getMissionControlSnapshot(runId: string): Promise<MissionControlSnapshot> {
    if (runId !== demoRunSnapshot.run.id) {
      throw new Error(`No demo run found for "${runId}".`);
    }

    const latestPolicy =
      this.policies.get(this.run.currentPolicyVersionId) ?? demoRunSnapshot.activePolicy;
    const latestTurn = this.turns[0];

    return {
      ...demoRunSnapshot,
      run: this.run,
      activePolicy: latestPolicy,
      currentObjective: latestTurn?.intent ?? demoRunSnapshot.currentObjective,
      latestDeliverable: demoRunSnapshot.latestDeliverable,
      pendingRequests: derivePendingRequests(this.events),
      recentTurns: this.turns,
      recentEvents: this.events
    };
  }

  async loadPolicyVersion(policyVersionId: string): Promise<PolicyVersion> {
    const policy = this.policies.get(policyVersionId);
    if (!policy) {
      throw new Error(`Unknown demo policy version "${policyVersionId}".`);
    }
    return policy;
  }

  async resolveCapabilities(input: ResolveCapabilitiesInput): Promise<ResolvedPolicy> {
    const enabled = demoRunSnapshot.dormantCapabilities.filter((capability) =>
      input.policyVersion.enabledCapabilityIds.includes(capability.id)
    );

    const seedEnabled = demoRunSnapshot.activePolicy.enabledCapabilityIds
      .filter((capabilityId) => input.policyVersion.enabledCapabilityIds.includes(capabilityId))
      .filter((capabilityId) => !enabled.some((capability) => capability.id === capabilityId))
      .map(
        (capabilityId) =>
          ({
            id: capabilityId,
            name: capabilityId,
            description: "Bootstrap capability seeded in demo mode.",
            capabilityClass: "read",
            bindingType: "tool",
            bindingSource: capabilityId,
            riskLevel: "low",
            costClass: "cheap",
            defaultScope: {},
            defaultTTLSeconds: null,
            dependencies: [],
            sideEffects: [],
            tags: ["bootstrap"]
          }) satisfies CapabilityDefinition
      );

    return {
      policyVersion: input.policyVersion,
      resolvedCapabilities: [...enabled, ...seedEnabled],
      agentDefinedCapabilities: this.agentDefinedCapabilities.filter(
        (adc) => adc.runId === input.runId && adc.status === "approved"
      ),
      expiresAtByCapabilityId: Object.fromEntries(
        input.policyVersion.grants.map((grant) => [grant.capabilityId, grant.expiresAt])
      )
    };
  }

  async recordRunEvent(input: RecordRunEventInput): Promise<void> {
    this.events = [
      {
        id: input.eventId ?? `event-${randomUUID()}`,
        runId: input.runId,
        turnId: input.turnId ?? null,
        eventType: input.eventType,
        actorType: input.actorType,
        actorId: input.actorId,
        payload: input.payload,
        createdAt: new Date().toISOString()
      },
      ...this.events
    ].slice(0, 24);
  }

  async updateRunStatus(input: UpdateRunStatusInput): Promise<void> {
    this.run = {
      ...this.run,
      status: input.status,
      currentPolicyVersionId: input.currentPolicyVersionId ?? this.run.currentPolicyVersionId,
      endedAt:
        input.endedAt !== undefined
          ? input.endedAt
          : input.status === "completed" || input.status === "failed" || input.status === "cancelled"
            ? new Date().toISOString()
            : this.run.endedAt
    };
  }

  async saveTurnResult(input: PersistTurnResultInput): Promise<RunTurn> {
    const turn: RunTurn = {
      id: makeTurnId(input.runId, input.turnNumber),
      runId: input.runId,
      turnNumber: input.turnNumber,
      policyVersionId: input.policyVersionId,
      status: turnStatusFromResult(input),
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      intent: input.result.intent,
      blockers: input.result.currentBlockers,
      summary: input.result.summary,
      deliverable: input.result.deliverable ?? "",
      metrics: input.result.metrics
    };

    this.turns = [turn, ...this.turns.filter((existing) => existing.turnNumber !== turn.turnNumber)].slice(
      0,
      8
    );

    return turn;
  }

  async applyPolicyMutation(input: ApplyPolicyMutationInput): Promise<PolicyVersion> {
    const currentPolicy = await this.loadPolicyVersion(input.policyVersionId);
    const enabledCapabilityIds = [...currentPolicy.enabledCapabilityIds];
    let grants = [...currentPolicy.grants];

    if (input.proposal.kind === "grant" || input.proposal.kind === "replace_scope") {
      ensureCapabilityEnabled(enabledCapabilityIds, input.proposal.capabilityId, true);
      grants = [
        ...grants.filter((grant) => grant.capabilityId !== input.proposal.capabilityId),
        nextGrantFromMutation(input)
      ];
    }

    if (input.proposal.kind === "revoke") {
      grants = grants.filter((grant) => grant.capabilityId !== input.proposal.capabilityId);
    }

    const nextVersionNumber =
      Math.max(
        0,
        ...Array.from(this.policies.values())
          .filter((policy) => policy.familyId === currentPolicy.familyId)
          .map((policy) => policy.versionNumber)
      ) + 1;

    const nextPolicy: PolicyVersion = {
      id: `policy-v${nextVersionNumber}`,
      familyId: currentPolicy.familyId,
      versionNumber: nextVersionNumber,
      governanceMode: currentPolicy.governanceMode,
      enabledCapabilityIds:
        input.proposal.kind === "revoke"
          ? enabledCapabilityIds.filter((capabilityId) => capabilityId !== input.proposal.capabilityId)
          : enabledCapabilityIds,
      grants,
      reason: input.proposal.reason,
      createdBy: input.approvedBy,
      createdAt: new Date().toISOString()
    };

    this.policies.set(nextPolicy.id, nextPolicy);
    this.run = {
      ...this.run,
      currentPolicyVersionId: nextPolicy.id
    };
    return nextPolicy;
  }

  private agentDefinedCapabilities: AgentDefinedCapability[] = [];

  async saveAgentDefinedCapability(input: SaveAgentDefinedCapabilityInput): Promise<AgentDefinedCapability> {
    const capability: AgentDefinedCapability = {
      id: `adc-${randomUUID()}`,
      runId: input.runId,
      name: input.name,
      description: input.description,
      parameterSchema: input.parameterSchema,
      scriptPath: input.scriptPath,
      scriptLanguage: input.scriptLanguage,
      riskLevel: "high",
      status: input.status ?? "pending",
      definedBy: "eren",
      approvedBy: input.approvedBy ?? null,
      createdAt: new Date().toISOString()
    };
    this.agentDefinedCapabilities.push(capability);
    return capability;
  }
}

type CacheEntry<T> = { value: T; expiresAt: number };

class PostgresRepository implements ErenRepository {
  private snapshotCache = new Map<string, CacheEntry<MissionControlSnapshot>>();
  private static readonly SNAPSHOT_TTL_MS = 2000;

  constructor(private readonly pool: Pool) {}

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const id = `run-${randomUUID()}`;
    const workflowId = `eren-run-${randomUUID()}`;

    await this.pool.query(
      `
        insert into runs (
          id,
          task,
          status,
          governance_mode,
          initial_policy_version_id,
          current_policy_version_id,
          workflow_id,
          started_at,
          ended_at
        )
        values ($1, $2, 'queued', $3, $4, $4, $5, now(), null)
      `,
      [id, input.task, input.governanceMode, input.initialPolicyVersionId, workflowId]
    );

    return {
      id,
      task: input.task,
      status: "queued",
      governanceMode: input.governanceMode,
      initialPolicyVersionId: input.initialPolicyVersionId,
      currentPolicyVersionId: input.initialPolicyVersionId,
      workflowId,
      startedAt: new Date().toISOString(),
      endedAt: null
    };
  }

  async listRuns(limit: number = 20, offset: number = 0): Promise<RunRecord[]> {
    return this.many<RunRow>(
      `
        select *
        from runs
        order by started_at desc
        limit $1
        offset $2
      `,
      [limit, offset]
    ).then((rows) => rows.map(mapRunRow));
  }

  async listPolicyVersions(limit: number = 20, offset: number = 0): Promise<PolicyVersion[]> {
    const rows = await this.many<PolicyVersionRow>(
      `
        select *
        from policy_versions
        order by version_number desc
        limit $1
        offset $2
      `,
      [limit, offset]
    );

    const policies: PolicyVersion[] = [];
    for (const row of rows) {
      const grants = await this.many<PolicyGrantRow>(
        `
          select *
          from policy_grants
          where policy_version_id = $1
          order by created_at asc
        `,
        [row.id]
      );
      policies.push(mapPolicyRow(row, grants.map(mapGrantRow)));
    }

    return policies;
  }

  async getMissionControlSnapshot(runId: string): Promise<MissionControlSnapshot> {
    const cached = this.snapshotCache.get(runId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    this.snapshotCache.delete(runId);

    const runRow = await this.one<RunRow>(
      `
        select *
        from runs
        where id = $1
      `,
      [runId]
    );

    if (!runRow) {
      throw new Error(`Run "${runId}" not found.`);
    }

    const run = mapRunRow(runRow);
    const activePolicy = await this.loadPolicyVersion(run.currentPolicyVersionId);
    const recentTurns = await this.many<RunTurnRow>(
      `
        select *
        from run_turns
        where run_id = $1
        order by turn_number desc
        limit 8
      `,
      [run.id]
    ).then((rows) => rows.map(mapTurnRow));

    const recentEvents = await this.many<RunEventRow>(
      `
        select *
        from run_events
        where run_id = $1
        order by created_at desc
        limit 24
      `,
      [run.id]
    ).then((rows) => rows.map(mapEventRow));

    const latestDeliverableRow = await this.one<{ deliverable: string | null }>(
      `
        select deliverable from (
          select metadata_json->>'deliverable' as deliverable, created_at
          from artifacts
          where run_id = $1
            and metadata_json ? 'deliverable'
          union all
          select deliverable, ended_at as created_at
          from run_turns
          where run_id = $1
            and deliverable <> ''
        ) combined
        order by created_at desc
        limit 1
      `,
      [run.id]
    );

    const dormantCapabilities = await this.many<CapabilityRow>(
      `
        select *
        from capabilities
        where not (id = any($1::text[]))
        order by risk_level asc, name asc
        limit 12
      `,
      [activePolicy.enabledCapabilityIds]
    ).then((rows) => rows.map(mapCapabilityRow));

    const pendingRequests = derivePendingRequests(recentEvents);

    const snapshot: MissionControlSnapshot = {
      run,
      activePolicy,
      currentObjective: recentTurns[0]?.intent ?? run.task,
      latestDeliverable: latestDeliverableRow?.deliverable ?? null,
      dormantCapabilities,
      pendingRequests,
      recentTurns,
      recentEvents
    };

    this.snapshotCache.set(runId, {
      value: snapshot,
      expiresAt: Date.now() + PostgresRepository.SNAPSHOT_TTL_MS
    });

    return snapshot;
  }

  async loadPolicyVersion(policyVersionId: string): Promise<PolicyVersion> {
    const policyRow = await this.one<PolicyVersionRow>(
      `
        select *
        from policy_versions
        where id = $1
      `,
      [policyVersionId]
    );

    if (!policyRow) {
      throw new Error(`Policy version "${policyVersionId}" not found.`);
    }

    const grantRows = await this.many<PolicyGrantRow>(
      `
        select *
        from policy_grants
        where policy_version_id = $1
        order by created_at asc
      `,
      [policyVersionId]
    );

    return mapPolicyRow(policyRow, grantRows.map(mapGrantRow));
  }

  async resolveCapabilities(input: ResolveCapabilitiesInput): Promise<ResolvedPolicy> {
    const capabilityRows = await this.many<CapabilityRow>(
      `
        select *
        from capabilities
        where id = any($1::text[])
      `,
      [input.policyVersion.enabledCapabilityIds]
    );

    type AgentDefinedCapabilityRow = {
      id: string;
      run_id: string;
      name: string;
      description: string;
      parameter_schema_json: Record<string, unknown>;
      script_path: string;
      script_language: "node" | "python3" | "bash";
      risk_level: string;
      status: string;
      defined_by: string;
      approved_by: string | null;
      created_at: string;
    };

    const adcRows = await this.many<AgentDefinedCapabilityRow>(
      `
        select *
        from agent_defined_capabilities
        where run_id = $1 and status = 'approved'
      `,
      [input.runId]
    );

    return {
      policyVersion: input.policyVersion,
      resolvedCapabilities: capabilityRows.map(mapCapabilityRow),
      agentDefinedCapabilities: adcRows.map((row) => ({
        id: row.id,
        runId: row.run_id,
        name: row.name,
        description: row.description,
        parameterSchema: row.parameter_schema_json,
        scriptPath: row.script_path,
        scriptLanguage: row.script_language,
        riskLevel: row.risk_level as AgentDefinedCapability["riskLevel"],
        status: row.status as AgentDefinedCapability["status"],
        definedBy: row.defined_by,
        approvedBy: row.approved_by,
        createdAt: new Date(row.created_at).toISOString()
      })),
      expiresAtByCapabilityId: Object.fromEntries(
        input.policyVersion.grants.map((grant) => [grant.capabilityId, grant.expiresAt])
      )
    };
  }

  async saveTurnResult(input: PersistTurnResultInput): Promise<RunTurn> {
    const turnId = makeTurnId(input.runId, input.turnNumber);

    await this.pool.query(
      `
        insert into run_turns (
          id,
          run_id,
          turn_number,
          policy_version_id,
          status,
          started_at,
          ended_at,
          intent,
          blockers_json,
          summary,
          deliverable,
          metrics_json
        )
        values ($1, $2, $3, $4, $5, now(), now(), $6, $7::jsonb, $8, $9, $10::jsonb)
        on conflict (run_id, turn_number)
        do update set
          policy_version_id = excluded.policy_version_id,
          status = excluded.status,
          ended_at = excluded.ended_at,
          intent = excluded.intent,
          blockers_json = excluded.blockers_json,
          summary = excluded.summary,
          deliverable = excluded.deliverable,
          metrics_json = excluded.metrics_json
      `,
      [
        turnId,
        input.runId,
        input.turnNumber,
        input.policyVersionId,
        turnStatusFromResult(input),
        input.result.intent,
        JSON.stringify(input.result.currentBlockers),
        input.result.summary,
        input.result.deliverable ?? "",
        JSON.stringify(input.result.metrics)
      ]
    );

    for (const artifact of input.result.artifacts) {
      await this.pool.query(
        `
          insert into artifacts (
            id,
            run_id,
            turn_id,
            artifact_type,
            path_or_url,
            metadata_json,
            created_at
          )
          values ($1, $2, $3, $4, $5, $6::jsonb, now())
          on conflict (id) do nothing
        `,
        [
          artifact.id,
          input.runId,
          turnId,
          artifact.kind,
          artifact.pathOrUrl,
          JSON.stringify(artifact.metadata)
        ]
      );
    }

    return {
      id: turnId,
      runId: input.runId,
      turnNumber: input.turnNumber,
      policyVersionId: input.policyVersionId,
      status: turnStatusFromResult(input),
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      intent: input.result.intent,
      blockers: input.result.currentBlockers,
      summary: input.result.summary,
      deliverable: input.result.deliverable ?? "",
      metrics: input.result.metrics
    };
  }

  async recordRunEvent(input: RecordRunEventInput): Promise<void> {
    const id = input.eventId ?? `event-${randomUUID()}`;

    await this.pool.query(
      `
        insert into run_events (
          id,
          run_id,
          turn_id,
          event_type,
          actor_type,
          actor_id,
          payload_json,
          created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
        on conflict (id) do nothing
      `,
      [
        id,
        input.runId,
        input.turnId ?? null,
        input.eventType,
        input.actorType,
        input.actorId,
        JSON.stringify(input.payload)
      ]
    );
  }

  async updateRunStatus(input: UpdateRunStatusInput): Promise<void> {
    await this.pool.query(
      `
        update runs
        set
          status = $1,
          current_policy_version_id = coalesce($2, current_policy_version_id),
          ended_at = case
            when $3::timestamptz is not null then $3::timestamptz
            when $1 in ('completed', 'failed', 'cancelled') then now()
            else ended_at
          end
        where id = $4
      `,
      [input.status, input.currentPolicyVersionId ?? null, input.endedAt ?? null, input.runId]
    );
  }

  async applyPolicyMutation(input: ApplyPolicyMutationInput): Promise<PolicyVersion> {
    const client = await this.pool.connect();

    try {
      await client.query("begin isolation level serializable");

      // Advisory lock on the run to prevent concurrent mutations.
      // Use modular arithmetic to keep the hash within PostgreSQL bigint range.
      const lockKey = Buffer.from(input.runId).reduce(
        (acc, byte) => ((acc * 31 + byte) & 0x7fffffff),
        0
      );
      await client.query("select pg_advisory_xact_lock($1)", [lockKey]);

      const existingPolicyEventResult = await client.query<{ policy_version_id: string }>(
        `
          select policy_version_id
          from policy_events
          where run_id = $1
            and diff_json->>'mutationId' = $2
          order by created_at desc
          limit 1
          for update
        `,
        [input.runId, input.proposal.mutationId]
      );

      const existingPolicyVersionId = existingPolicyEventResult.rows[0]?.policy_version_id;
      if (existingPolicyVersionId) {
        const existingPolicy = await this.loadPolicyVersionWithClient(client, existingPolicyVersionId);
        await client.query("commit");
        return existingPolicy;
      }

      const currentPolicy = await this.loadPolicyVersionWithClient(client, input.policyVersionId);
      const enabledCapabilityIds = [...currentPolicy.enabledCapabilityIds];
      let grants = [...currentPolicy.grants];

      if (input.proposal.kind === "grant" || input.proposal.kind === "replace_scope") {
        ensureCapabilityEnabled(enabledCapabilityIds, input.proposal.capabilityId, true);
        grants = [
          ...grants.filter((grant) => grant.capabilityId !== input.proposal.capabilityId),
          nextGrantFromMutation(input)
        ];
      }

      if (input.proposal.kind === "revoke") {
        grants = grants.filter((grant) => grant.capabilityId !== input.proposal.capabilityId);
      }

      const nextVersionNumberResult = await client.query<{ next_version_number: number }>(
        `
          select coalesce(max(version_number), 0) + 1 as next_version_number
          from policy_versions
          where policy_family_id = $1
        `,
        [currentPolicy.familyId]
      );
      const nextVersionNumber = nextVersionNumberResult.rows[0]?.next_version_number ?? 1;
      const nextPolicyId = `policy-${randomUUID()}`;
      const nextEnabledCapabilityIds =
        input.proposal.kind === "revoke"
          ? enabledCapabilityIds.filter((capabilityId) => capabilityId !== input.proposal.capabilityId)
          : enabledCapabilityIds;

      const policyJson = {
        enabledCapabilityIds: nextEnabledCapabilityIds
      };
      const persistedGrants = grants.map((grant) => ({
        ...grant,
        id: `grant-${randomUUID()}`
      }));

      await client.query(
        `
          insert into policy_versions (
            id,
            policy_family_id,
            version_number,
            governance_mode,
            policy_json,
            policy_hash,
            created_by,
            reason,
            created_at
          )
          values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, now())
        `,
        [
          nextPolicyId,
          currentPolicy.familyId,
          nextVersionNumber,
          currentPolicy.governanceMode,
          JSON.stringify(policyJson),
          hashPolicy(nextEnabledCapabilityIds, persistedGrants),
          input.approvedBy,
          input.proposal.reason
        ]
      );

      for (const grant of persistedGrants) {
        await client.query(
          `
            insert into policy_grants (
              id,
              policy_version_id,
              capability_id,
              scope_json,
              ttl_seconds,
              granted_by,
              grant_type,
              reason,
              expires_at,
              created_at
            )
            values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
          `,
          [
            grant.id,
            nextPolicyId,
            grant.capabilityId,
            JSON.stringify(grant.scope),
            grant.ttlSeconds,
            grant.grantedBy,
            grant.grantType,
            grant.reason,
            grant.expiresAt,
            grant.createdAt
          ]
        );
      }

      await client.query(
        `
          update runs
          set current_policy_version_id = $1
          where id = $2
        `,
        [nextPolicyId, input.runId]
      );

      await client.query(
        `
          insert into policy_events (
            id,
            run_id,
            policy_version_id,
            event_type,
            diff_json,
            reason,
            created_at
          )
          values ($1, $2, $3, $4, $5::jsonb, $6, now())
        `,
        [
          `policy-event-${randomUUID()}`,
          input.runId,
          nextPolicyId,
          `policy.${input.proposal.kind}`,
          JSON.stringify({
            mutationId: input.proposal.mutationId,
            capabilityId: input.proposal.capabilityId,
            requestedScope: input.scopeOverride ?? input.proposal.requestedScope,
            ttlSeconds: input.ttlOverrideSeconds ?? input.proposal.requestedTTLSeconds ?? null
          }),
          input.proposal.reason
        ]
      );

      await client.query("commit");

      return {
        id: nextPolicyId,
        familyId: currentPolicy.familyId,
        versionNumber: nextVersionNumber,
        governanceMode: currentPolicy.governanceMode,
        enabledCapabilityIds: nextEnabledCapabilityIds,
        grants: persistedGrants,
        reason: input.proposal.reason,
        createdBy: input.approvedBy,
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadPolicyVersionWithClient(
    client: PoolClient,
    policyVersionId: string
  ): Promise<PolicyVersion> {
    const policyRowResult = await client.query<PolicyVersionRow>(
      `
        select *
        from policy_versions
        where id = $1
      `,
      [policyVersionId]
    );

    const policyRow = policyRowResult.rows[0];

    if (!policyRow) {
      throw new Error(`Policy version "${policyVersionId}" not found.`);
    }

    const grantRowResult = await client.query<PolicyGrantRow>(
      `
        select *
        from policy_grants
        where policy_version_id = $1
        order by created_at asc
      `,
      [policyVersionId]
    );

    return mapPolicyRow(policyRow, grantRowResult.rows.map(mapGrantRow));
  }

  async saveAgentDefinedCapability(input: SaveAgentDefinedCapabilityInput): Promise<AgentDefinedCapability> {
    const id = `adc-${randomUUID()}`;
    const now = new Date().toISOString();

    await this.pool.query(
      `
        insert into agent_defined_capabilities (
          id, run_id, name, description, parameter_schema_json,
          script_path, script_language, risk_level, status, defined_by, approved_by, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `,
      [
        id,
        input.runId,
        input.name,
        input.description,
        JSON.stringify(input.parameterSchema),
        input.scriptPath,
        input.scriptLanguage,
        "high",
        input.status ?? "pending",
        "eren",
        input.approvedBy ?? null,
        now
      ]
    );

    return {
      id,
      runId: input.runId,
      name: input.name,
      description: input.description,
      parameterSchema: input.parameterSchema,
      scriptPath: input.scriptPath,
      scriptLanguage: input.scriptLanguage,
      riskLevel: "high",
      status: input.status ?? "pending",
      definedBy: "eren",
      approvedBy: input.approvedBy ?? null,
      createdAt: now
    };
  }

  private async one<T extends QueryResultRow>(
    query: string,
    values: RowValue[]
  ): Promise<T | null> {
    const result = await this.pool.query<T>(query, values);
    return result.rows[0] ?? null;
  }

  private async many<T extends QueryResultRow>(
    query: string,
    values: RowValue[]
  ): Promise<T[]> {
    const result = await this.pool.query<T>(query, values);
    return result.rows;
  }
}

function derivePendingRequests(events: RunEvent[]): PendingCapabilityRequest[] {
  const resolvedRequestIds = new Set<string>();
  const pending = new Map<string, PendingCapabilityRequest>();

  for (const event of events) {
    const requestId =
      typeof event.payload.requestId === "string"
        ? event.payload.requestId
        : typeof event.payload.mutationId === "string"
          ? event.payload.mutationId
          : null;

    if (requestId && ["approval.approved", "approval.denied", "policy.applied"].includes(event.eventType)) {
      resolvedRequestIds.add(requestId);
    }
  }

  for (const event of events) {
    if (!["capability.requested", "approval.requested"].includes(event.eventType)) {
      continue;
    }

    const requestId =
      typeof event.payload.requestId === "string"
        ? event.payload.requestId
        : typeof event.payload.mutationId === "string"
          ? event.payload.mutationId
          : typeof event.payload.capabilityId === "string"
            ? `${event.eventType}:${event.payload.capabilityId}`
            : null;

    if (!requestId || resolvedRequestIds.has(requestId)) {
      continue;
    }

    pending.set(requestId, {
      requestId,
      capabilityId:
        typeof event.payload.capabilityId === "string" ? event.payload.capabilityId : "unknown",
      reason: typeof event.payload.reason === "string" ? event.payload.reason : "No reason recorded.",
      fallbackIfDenied:
        typeof event.payload.fallbackIfDenied === "string"
          ? event.payload.fallbackIfDenied
          : "Fallback not recorded."
    });
  }

  return [...pending.values()];
}

let sharedPool: Pool | null = null;
let sharedDemoRepository: DemoRepository | null = null;

export function createRepository(): ErenRepository {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    sharedDemoRepository ??= new DemoRepository();
    return sharedDemoRepository;
  }

  sharedPool ??= new PostgresPool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });

  return new PostgresRepository(sharedPool);
}
