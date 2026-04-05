# Agents

This document describes Eren's agent architecture: how the agent executes, what tools it has, how it acquires new capabilities, and how governance constrains its behavior.

## Agent Identity

Eren is a single named agent, not a generic assistant. It operates as a self-modifying operator that can inspect and change its own capability surface across turns. The model stays fixed; the runtime changes.

Eren runs on Google Vertex AI using Gemini models (default: `gemini-2.5-flash`, configurable via `EREN_MODEL`).

## Execution Model

Eren operates in **discrete turns** within **durable runs** orchestrated by Temporal.

```
Run
 └─ Turn 1 (policy v1 → resolve capabilities → execute → emit result)
 └─ Turn 2 (policy v2 → resolve capabilities → execute → emit result)
 └─ ...
 └─ Turn N (terminal: completed | failed | max turns)
```

Each turn:

1. The workflow loads the current policy version.
2. The capability resolver computes the allowed tool surface.
3. A fresh execution worker spawns with only the allowed tools.
4. Eren receives a system instruction, task context, and function declarations.
5. Eren iterates tool calls (up to 8 per turn) until it submits a terminal result.
6. The structured `TurnResult` is persisted and events are emitted.

**Critical rule**: capability changes apply on the next turn, never during the currently running turn.

## Turn Result Contract

Every turn produces a typed envelope:

```ts
type TurnResult = {
  status: "continue" | "blocked" | "completed" | "failed";
  summary: string;
  actions: RunAction[];
  capabilityRequests: CapabilityRequest[];
  policyMutations: PolicyMutationProposal[];
  delegationRequests: DelegationRequest[];
  artifacts: ArtifactRef[];
  metrics: TurnMetrics;
};
```

## Tools

Tools are dynamically assembled from the resolved policy. Eren only sees function declarations for capabilities it currently holds.

### Always Available

| Tool | Purpose |
|------|---------|
| `publish_reasoning_step` | Emit structured reasoning (assessment, evidence, decision, completion) |
| `submit_turn_result` | Terminal function — ends the turn with a structured result |

### Capability-Gated

| Tool | Required Capability | Purpose |
|------|---------------------|---------|
| `read_workspace_file` | `fs.read.workspace` | Read files from the workspace |
| `write_workspace_file` | `fs.write.workspace` | Write files to the workspace |
| `execute_shell` | `shell.execute` | Execute shell commands |
| `request_capability_grant` | `policy.propose` | Request a new capability from the registry |

Tools are conditionally included based on `resolvedPolicy.resolvedCapabilities`. Under `full` or `auto` governance modes, all tools are granted.

## Capability Model

A capability is not just a tool function. Capabilities represent access rights across the system:

- **Classes**: read, write, network, browser, scheduler, worker, deployment, secrets, meta-governance
- **Binding types**: global, tool, service
- **Risk levels**: low, medium, high, critical
- **Cost classes**: cheap, metered, expensive
- **Grant types**: permanent, session, lease (with TTL)

Each capability declares dependencies, side effects, default scope, and default TTL. The registry lives in Postgres (`capabilities` table) and is seeded from structured config.

## Capability Acquisition

Eren can request new capabilities through `request_capability_grant`. What happens next depends on the governance mode:

| Mode | Behavior |
|------|----------|
| `observe` | Eren auto-applies mutations; no approval needed |
| `shadow` | Proposals are recorded but policy stays unchanged |
| `gated` | Workflow pauses; operator must approve via signal |
| `lease` | Self-grants allowed only with TTL expiration |
| `budgeted` | Self-grants constrained by risk/cost budget |
| `full` | All capabilities permanently available |
| `auto` | Automatic approval for safe mutations |
| `chaos` | System randomly delays, denies, or perturbs grants |

When a grant is approved, a new policy version is created (policies are immutable and versioned). The next turn resolves capabilities from the updated policy.

## Policy Versioning

Policies are never mutated in place. Every change produces a new version with:

- Version number
- Enabled capability IDs
- Individual grants (with scope, TTL, reason, issuer)
- Governance mode
- Full audit trail (created_by, reason, timestamp)

Policy diffs are human-readable and machine-readable for replay and comparison.

## Workflow Orchestration

Runs are orchestrated by `RunWorkflow` in Temporal, which handles:

- Turn loop with pause/resume support
- Governance decision routing
- Approval gates (waits for operator signal in `gated` mode)
- Event emission at every state transition
- Termination on completion, failure, or max turns

### Signals

| Signal | Purpose |
|--------|---------|
| `pauseRunSignal` | Pause the run; workflow waits |
| `resumeRunSignal` | Resume a paused run |
| `operatorNoteSignal` | Queue a note for the next turn's context |
| `grantDecisionSignal` | Deliver an approve/deny/modify decision |

### Supporting Workflows (Planned)

- `GrantApprovalWorkflow` — manages human review of capability requests
- `LeaseExpiryWorkflow` — tracks temporary grants and triggers revocation
- `SubagentWorkflow` — runs child agents with narrower policies
- `BenchmarkSuiteWorkflow` — runs the same task across different policy regimes
- `ScheduledSelfAuditWorkflow` — periodic policy review

## Memory Model

Memory is separated from policy into distinct domains:

- **Identity memory**: who Eren is, tone, mission, stable instructions
- **Run memory**: scratchpad and notes for a specific run
- **Long-term memory**: learned heuristics, prior lessons
- **Policy state**: current powers and grant history

These are kept separate to support debugging, replay, and benchmarking.

## Observability

Every significant action produces a structured `RunEvent`:

- `run.started`, `run.completed`, `run.failed`, `run.max_turns_reached`
- `turn.completed`
- `capability.requested`
- `approval.requested`, `approval.approved`, `approval.denied`
- `policy.proposed`, `policy.applied`
- `agent.reasoning`, `agent.error`
- `tool.called`, `tool.result`

Events include run ID, turn ID, actor, event type, payload, timestamp, and policy version context. The full causal chain from policy change to outcome is inspectable and replayable.

## Communication Style

Eren reports using structured self-report fields:

- `intent` — what it plans to do
- `current blockers` — what's stopping progress
- `requested capability` — what power it wants
- `justification` — why it needs it
- `risk` — what could go wrong
- `fallback if denied` — alternative plan
- `next planned action` — what happens next

First-person, concise, explicit about intent and power changes. No conversational fluff.

## Key Files

| File | Purpose |
|------|---------|
| `packages/temporal/src/workflows/run-workflow.ts` | Main workflow: turn loop, governance, signals |
| `packages/temporal/src/runtime/vertex-agent.ts` | Vertex AI agent execution and tool system |
| `packages/temporal/src/activities/index.ts` | Activity implementations bridging workflow and execution |
| `packages/domain/src/index.ts` | All domain types, schemas, and enums |
| `packages/persistence/src/` | Repository layer (demo + Postgres) |
| `infra/postgres/schema.sql` | Database schema |

## Phased Agent Evolution

**Phase 1 (current)**: Single agent, capability registry, policy versioning, gated approvals, per-turn execution.

**Phase 2**: All governance modes, TTL grants, rollback, budget accounting, benchmarks.

**Phase 3**: Subagents with narrower policies, role-based profiles, scheduled self-audits, policy linting.

**Phase 4**: Multi-agent societies, internal governance structures, adversarial tournaments, long-horizon autonomy studies.
