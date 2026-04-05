# Eren Architecture Plan

This document captures the current architectural direction for Eren so future agents can work from a shared model instead of reconstructing it from chat history. Read this alongside `prd.md`.

## 1. Product Framing

Eren is not a standard chatbot with extra tools.

Eren is a self-modifying operator whose main novelty is that it can change the capability surface available to it across turns. The product is therefore not primarily a messaging UI. It is a research and control environment for observing how Eren behaves as its powers, policies, and governance constraints evolve.

The system should optimize for:

- observability over convenience
- explicit policy mutation over implicit hidden state
- replayability over ad hoc runtime behavior
- durable orchestration over one-shot request/response flows
- a strong named agent identity, `Eren`, over a generic assistant abstraction

## 2. Core Product Thesis

The central loop is:

1. Eren receives a task and an initial policy.
2. The system materializes an execution environment from that policy.
3. Eren inspects current powers and dormant capabilities.
4. Eren either does task work, requests new powers, modifies policy, delegates, or pauses.
5. Any policy mutation is persisted as a versioned change.
6. The next turn rebuilds the environment from the new policy.
7. Operators can inspect the full causal chain from policy change to downstream outcome.

The main product question is not "can Eren solve the task?"

The main product question is "how does Eren behave when it can redesign the conditions under which it solves the task?"

## 3. Product Shape

The primary UX should be a mission-control interface, not a normal back-and-forth chat app.

The default interaction model should be single-speaker and turn-based:

- Eren reports intent, actions, requests, and outcomes.
- The operator intervenes when needed.
- Human messages are sparse and high leverage rather than constant.

Recommended operator modes:

- Research mode: Eren speaks by default, operator mainly observes.
- Approval mode: operator responds only to grant requests or governance interruptions.
- Interview mode: operator can ask Eren questions during a run without turning the product into a standard chat surface.

The product should feel like observing a live durable process, not texting with a bot.

## 4. High-Level Architecture

The recommended architecture is:

- `Next.js + TypeScript` for the operator UI and app API
- `Temporal` for durable orchestration of runs, approvals, timers, retries, and subagents
- `Postgres` for product data, policy versions, event projections, and analytics-friendly querying
- `TypeScript workers` for model invocation, tool execution, policy validation, and sandbox execution activities
- `Python sidecar` for offline research workflows, benchmark analysis, notebooks, and evaluation plots
- local filesystem first for artifacts, with object storage later if needed

Design principle:

- Temporal owns orchestration.
- Postgres owns domain state and queryable history.
- Workers own nondeterministic execution.
- The UI owns observability and operator control.

## 5. Why Temporal

Temporal should be a first-class part of the design because Eren is inherently a long-lived, interruptible, multi-step system.

Eren needs:

- long-running missions
- pause and resume
- approval gates
- retries
- timers for leases and expirations
- scheduled self-audits
- child processes or subagents
- durable recovery after crashes or deploys

Those are orchestration problems, not merely application routing problems.

Temporal is the correct place to manage:

- run lifecycle
- waiting for human approval
- sleeping until TTL expiration
- child workflow coordination
- benchmark fan-out and comparison runs
- durable step transitions

Temporal should not replace the main product database. The app still needs clean Postgres-backed records for policies, projections, events, and UI queries.

## 6. Architectural Layers

### 6.1 Immutable Core

The immutable core is the trusted runtime shell that Eren cannot rewrite from within the experiment.

Responsibilities:

- start and stop runs
- load policy versions
- resolve capability exposure for a given turn
- validate grants and dependencies
- spawn per-turn execution workers
- persist structured events
- coordinate governance decisions
- support replay and comparison

This layer should stay small, explicit, and heavily typed.

### 6.2 Mutable Policy Layer

This is where Eren's power surface changes over time.

Responsibilities:

- capability registry
- active policy
- grants and expirations
- scopes
- budgets
- risk labels
- reasons and issuers
- dependency constraints

This layer must be versioned, diffable, and replayable.

### 6.3 Execution Layer

Each execution turn should run in a fresh worker context assembled from the currently active policy.

Important rule:

- capability changes affect future turns, not the currently running turn

That preserves the experiment's integrity and keeps the system easier to reason about.

### 6.4 Observability Layer

This is a first-class product surface, not an afterthought.

Responsibilities:

- append-only event log
- policy diffs
- workflow status
- grant history
- artifacts
- run metrics
- replay views
- policy comparisons

## 7. Runtime Model

Eren should operate in discrete turns rather than one unbounded process mutating itself live.

Recommended turn lifecycle:

1. Operator starts a run with task, governance mode, and initial policy.
2. `RunWorkflow` loads the latest active policy version.
3. Capability resolver computes the allowed tool/global surface for the next turn.
4. Workflow invokes a `RunTurn` activity.
5. A fresh execution worker is spawned with only the allowed capabilities.
6. Eren works on the task and returns structured output.
7. Structured output may include:
- task actions performed
- artifacts produced
- capability requests
- policy mutation proposals
- delegation requests
- completion or failure signals
- a concise narrative summary for the UI
8. The workflow evaluates the result.
9. If approval is needed, the workflow pauses and waits for a signal.
10. If a policy mutation is accepted, the system writes a new policy version.
11. The next turn resolves capabilities again from the new policy.
12. The run ends on success, failure, timeout, manual stop, or governance termination.

This structure is the core of the product.

## 8. Temporal Workflow Design

### 8.1 Primary Workflow

`RunWorkflow`

Responsibilities:

- initialize run state
- load starting policy
- orchestrate each turn
- wait on approvals when needed
- apply accepted policy mutations
- enforce timeouts and termination rules
- fan out to subagents when enabled
- emit workflow-level events

### 8.2 Supporting Workflows

`GrantApprovalWorkflow`

- manages human review of requested capability changes
- records approve, deny, or modify outcomes
- returns an explicit decision to the parent workflow

`LeaseExpiryWorkflow`

- tracks temporary grants and revocations
- emits expiration events
- can trigger policy cleanup or a follow-up Eren turn

`SubagentWorkflow`

- runs a child agent with a narrower or modified policy
- reports outputs back to the parent run

`BenchmarkSuiteWorkflow`

- runs the same task across multiple initial policy regimes
- aggregates metrics for comparison

`ScheduledSelfAuditWorkflow`

- lets Eren schedule periodic maintenance or policy review tasks

### 8.3 Workflow Determinism Rule

Temporal workflow code must remain deterministic.

Therefore:

- workflow code handles state transitions, timers, and signals
- activities handle LLM calls, tool execution, file I/O, network I/O, and other nondeterministic behavior

Do not place raw model reasoning or live tool effects directly in workflow code.

## 9. Worker and Activity Design

TypeScript workers should implement activities such as:

- `loadPolicyVersion`
- `resolveCapabilities`
- `runTurn`
- `validatePolicyMutation`
- `applyPolicyMutation`
- `recordRunEvent`
- `storeArtifact`
- `startSubagent`
- `scoreBenchmarkOutcome`

The most important activity is `runTurn`.

`runTurn` should:

- receive the task context
- receive the effective policy and resolved capability surface
- launch a fresh turn environment
- expose only the allowed globals and tools
- call the model
- collect tool usage and emitted outputs
- return a structured result object

The result should not be just raw text. It should be a typed envelope.

Suggested result shape:

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

## 10. Data Model

Postgres should hold durable domain data and queryable projections.

Suggested first-pass tables:

### 10.1 Capability Registry

`capabilities`

- `id`
- `name`
- `description`
- `binding_type`
- `binding_source`
- `risk_level`
- `cost_class`
- `default_scope`
- `default_ttl_seconds`
- `tags`
- `dependencies_json`
- `side_effects_json`
- `created_at`
- `updated_at`

### 10.2 Policy Versions

`policy_versions`

- `id`
- `policy_family_id`
- `version_number`
- `governance_mode`
- `policy_json`
- `policy_hash`
- `created_by`
- `reason`
- `created_at`

`policy_grants`

- `id`
- `policy_version_id`
- `capability_id`
- `scope_json`
- `ttl_seconds`
- `granted_by`
- `grant_type`
- `reason`
- `expires_at`
- `created_at`

### 10.3 Runs

`runs`

- `id`
- `task`
- `status`
- `governance_mode`
- `initial_policy_version_id`
- `current_policy_version_id`
- `workflow_id`
- `started_at`
- `ended_at`

`run_turns`

- `id`
- `run_id`
- `turn_number`
- `policy_version_id`
- `status`
- `started_at`
- `ended_at`
- `summary`
- `metrics_json`

### 10.4 Events

`run_events`

- `id`
- `run_id`
- `turn_id`
- `event_type`
- `actor_type`
- `actor_id`
- `payload_json`
- `created_at`

`policy_events`

- `id`
- `run_id`
- `policy_version_id`
- `event_type`
- `diff_json`
- `reason`
- `created_at`

### 10.5 Artifacts

`artifacts`

- `id`
- `run_id`
- `turn_id`
- `artifact_type`
- `path_or_url`
- `metadata_json`
- `created_at`

### 10.6 Benchmarks

`benchmark_suites`

- `id`
- `name`
- `description`
- `created_at`

`benchmark_runs`

- `id`
- `suite_id`
- `run_id`
- `variant_name`
- `score_json`
- `created_at`

## 11. Memory Model

Separate memory from policy.

Recommended memory domains:

- identity memory: who Eren is, tone, mission, stable instructions
- run memory: scratchpad and evolving notes for a specific run
- long-term memory: learned heuristics, prior lessons, reusable facts
- policy state: current powers and grant history

Do not merge these into one blob. That will make debugging, replay, and benchmarking much harder.

## 12. Capability Model

A capability is not just a tool function.

Capabilities may represent:

- file read access
- file write access
- browser access
- network access
- scheduler access
- deployment rights
- secret access
- subagent delegation rights
- policy editing rights
- meta-governance rights

Each capability should define:

- id
- display name
- description
- binding type
- binding source
- dependencies
- risk level
- cost class
- scope semantics
- default TTL
- whether approval is required
- whether it can be self-granted under lease or budget rules

## 13. Governance Model

Supported modes from the PRD remain valid:

- `observe`
- `shadow`
- `gated`
- `lease`
- `budgeted`
- `chaos`

Recommended implementation notes:

- `observe`: Eren can directly mutate policy, mutation applies next turn
- `shadow`: Eren may propose mutations but active policy does not change
- `gated`: human approval required before mutation becomes active
- `lease`: self-grants are allowed only with expiration
- `budgeted`: self-grants must fit within a configured cost or risk budget
- `chaos`: grants may be delayed, denied, or perturbed by the system to test robustness

Governance should be visible in the UI at all times.

## 14. Interaction and UI Model

Do not design the first product as a standard assistant chat screen.

The primary screen should be a control-room layout with at least four information surfaces:

### 14.1 Run Setup Pane

- task input
- governance mode
- initial policy preset
- time budget
- risk budget
- benchmark or normal run selection

### 14.2 Main Run Journal

This is the central feed of what Eren is doing.

Each turn should show:

- current objective
- action summary
- tool usage
- capability requests
- artifacts produced
- outcome

Eren's voice should be first-person and explicit, but not a raw chain-of-thought dump.

### 14.3 Policy and Capability Pane

- active policy version
- enabled capabilities
- dormant capabilities
- pending grant requests
- temporary grants and time remaining

This pane should make power changes legible in real time.

### 14.4 Timeline and Metrics Pane

- event stream
- policy diffs
- approval events
- retries
- rollbacks
- turn durations
- meta-governance vs task-work ratio

### 14.5 Replay and Compare Views

Replay should be a first-class screen, not an afterthought.

Required views:

- replay a run turn by turn
- compare two runs side by side
- compare policy growth trajectories
- compare benchmark outcomes under different capability regimes

## 15. Communication Style for Eren

Eren should feel like a named operator, not a generic assistant and not a theatrical character.

Recommended style:

- first-person
- concise
- explicit about intent
- explicit about requested powers
- explicit about what changes on the next turn

Avoid:

- pretending hidden reasoning is inherently trustworthy
- uncontrolled monologues
- conversational fluff

Suggested structured self-report fields:

- `intent`
- `current blockers`
- `requested capability`
- `justification`
- `risk`
- `fallback if denied`
- `next planned action`

## 16. Observability and Replay

Observability is part of the product thesis.

Every important action should produce an event with:

- run id
- turn id
- actor
- event type
- payload
- timestamp
- policy version context

Replay requirements:

- view the exact effective policy on each turn
- view capability diffs between turns
- view the workflow state transitions
- view artifacts generated by each turn
- inspect approvals, denials, and expirations
- compare outcome changes after specific grants

Deterministic replay should be supported where feasible, but the UX should not depend on perfect determinism to remain useful.

## 17. MVP Build Plan

### Phase 1: Core Loop

Build first:

- one named agent: Eren
- capability registry
- policy versioning
- run creation
- one Temporal `RunWorkflow`
- fresh per-turn execution worker
- structured run events
- gated approvals for capability changes
- basic mission-control UI
- replay screen for a single run

Do not build yet:

- multi-agent societies
- constitutions
- advanced scheduler mesh
- broad plugin marketplace abstractions

### Phase 2: Governance Expansion

- `observe`, `shadow`, `lease`, and `budgeted` modes
- TTL grants
- automatic expiration
- rollback to previous policy versions
- budget accounting
- benchmark suite workflow

### Phase 3: Delegation and Research Power

- subagent workflows
- role-based policy profiles
- scheduled self-audits
- side-by-side run comparison
- policy linting
- richer eval dashboards

### Phase 4: Advanced Experiments

- multi-agent societies
- internal governance structures
- adversarial tournaments
- long-horizon policy drift studies

## 18. Important Open Questions

These questions are still important and should remain visible to future contributors:

- Is Eren a single persistent identity across runs, or a fresh instance with optional memory carryover?
- Can Eren mutate only capability policy, or also prompt, memory rules, and self-governance rules?
- What is the exact unit of a grant: turn, run, session, permanent, or TTL lease?
- Which capabilities are hard-forbidden regardless of governance mode?
- Can Eren create subagents directly, or only request permission to do so?
- Should subagents get child workflows or lightweight delegated tasks first?
- What degree of reasoning transparency should the UI expose?
- How should benchmark success be scored across heterogeneous tasks?
- How do we distinguish productive self-governance from bureaucracy and tool hoarding?
- Which operator actions should be signals versus explicit separate workflows?
- How much should live workflow history be sourced from Temporal versus replicated into Postgres projections?

## 19. Non-Negotiable Design Rules

These should remain stable unless intentionally reconsidered:

- Eren is not a normal chatbot product.
- Policy mutation is explicit and versioned.
- Capability changes apply on the next turn, not during the currently running turn.
- Temporal is the orchestration spine.
- Postgres is the domain and observability store.
- Workers own nondeterministic execution.
- Observability is a first-class product feature.
- The first UI is mission control, not chat-first.
- The first version is single-agent, not multi-agent.

## 20. Recommended Immediate Next Steps

The next practical implementation moves should be:

1. define the TypeScript domain types for capabilities, policies, grants, runs, turns, and events
2. define the first Postgres schema
3. scaffold the Temporal `RunWorkflow` and `runTurn` activity boundary
4. define the typed `TurnResult` contract
5. design the first mission-control screen
6. create one simple benchmark task and one gated approval flow

If later agents need a default interpretation, they should assume this document is the current source of truth for architecture unless superseded by a newer design doc.
