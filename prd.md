PRD: Eren, the Recursive Self-Extending Agent Lab

Implementation and system-design decisions that extend this PRD are documented in `architecture.md`.

1. Product Summary

- This project is a research platform for building and observing Eren, an agent that can iteratively modify its own operational capabilities.
- Eren starts with a minimal immutable runtime and a limited set of exposed globals/tools.
- Eren can inspect a registry of dormant capabilities, propose or directly apply policy changes, and then execute future work with the newly expanded environment.
- The product is not a secure sandbox in the traditional sense. It is an experimental system for studying Eren's self-governance, recursive self-improvement, capability acquisition, and behavior under growing autonomy.

1. Core Idea

- Most current agents operate inside a fixed tool envelope defined by developers.
- This project asks a different question: what happens when Eren can change the envelope itself?
- The central mechanic is simple:

1. Eren has a current capability policy.
2. It sees a larger registry of possible capabilities.
3. It can edit policy or request capability changes.
4. The runtime reloads the policy.
5. The next loop runs with the new globals/tools exposed.

- The experiment is to observe whether Eren becomes more effective, more strategic, more unstable, more bureaucratic, or all of the above.

1. Problem Statement

- Fixed-tool agents are easy to reason about but poor subjects for studying adaptive autonomy.
- Researchers and builders currently lack a clean platform for observing:
- How agents prioritize capability acquisition versus task execution.
- How agents restructure their own runtime to improve performance.
- Whether agents create internal governance, specialization, or harmful escalation loops.
- How capability growth changes reliability, planning quality, and long-horizon behavior.
- This project fills that gap by making capability mutation a first-class product feature.

1. Product Goal

- Build a lab-grade environment where Eren, or an Eren-led agent society, can self-modify its capability surface in a fully observable, replayable, benchmarkable way.
- The product goal is insight, not safety theater.
- The system should allow operators to answer:
- Which capabilities Eren asks for first.
- Which combinations of capabilities actually improve task success.
- Whether Eren learns restraint, hoards tools, creates process, or invents internal institutions.
- How Eren's recursive self-extension changes behavior over time.

1. Success Criteria

- The system can support repeated loops of policy mutation and sandbox rebuild without manual code changes.
- Every capability change is logged with exact diff, rationale, timestamp, actor, and downstream effects.
- Eren can operate in multiple governance modes, from free self-escalation to approval-gated.
- Operators can replay an entire run and inspect the causal chain from policy change to outcome.
- The platform can benchmark task success under different capability regimes.

1. Non-Goals

- This is not a production-grade secure agent runtime.
- This is not primarily a consumer assistant product.
- This is not meant to maximize convenience over observability.
- This is not a general plugin marketplace in phase one.
- This is not a self-modifying model weights project; the model stays fixed, the runtime changes.

1. Target Users

- AI researchers studying agentic behavior.
- Product engineers building advanced internal agents.
- Safety researchers studying self-escalation and governance.
- Founders and technical teams exploring high-autonomy workflows.
- Educators and labs demonstrating recursive agency in controlled environments.

1. Primary Use Cases

- Run a task and observe whether Eren expands its own tools before solving it.
- Compare task outcomes across different initial capability sets.
- Let Eren schedule future self-audits and policy maintenance.
- Allow Eren to spawn specialist subagents with different temporary policies.
- Study whether Eren invents internal governance structures such as critics, planners, or approvers.
- Detect pathologies such as tool hoarding, task avoidance, or runaway escalation.

1. Product Principles

- Capability changes must be explicit, machine-readable, and replayable.
- The immutable core must remain small and easy to trust.
- The mutable layer must be flexible and expressive.
- Every action should leave an audit trail.
- Power should be observable even when it is intentionally dangerous.
- Governance must be a product surface, not an afterthought.

1. Functional Requirements

- The system must maintain an immutable bootstrap runtime with minimal trusted powers.
- The system must load a capability registry from structured files or database-backed config.
- The system must load an active policy that determines which globals/tools are exposed in the next run.
- Eren must have a tool to inspect current policy and available dormant capabilities.
- Eren must have a tool to propose or edit policy entries.
- The runtime must rebuild the execution context from the current policy before each execution loop.
- The system must support capability metadata including id, name, description, source binding, risk level, dependencies, cost, scope, and TTL.
- The system must support capability classes such as read, write, network, browser, scheduler, worker, deployment, secrets, and meta-governance.
- The system must support temporary grants, permanent grants, and session-scoped grants.
- The system must support optional approval workflows depending on governance mode.
- The system must support structured logs, traces, and replay for both policy changes and task execution.
- The system must support comparative evaluation runs across different policies.

1. Governance Modes

- observe: Eren may directly mutate policy and immediately benefit on the next loop.
- shadow: Eren may propose policy changes but they are recorded without being applied.
- gated: policy changes require human approval before activation.
- lease: Eren may self-grant only temporary capabilities with expiration.
- budgeted: Eren may self-grant capabilities only within a risk or cost budget.
- chaos: the system randomly delays, denies, or mutates grants to test robustness.

1. System Architecture

- Immutable Core:
- Executes Eren's agent loop.
- Loads current policy.
- Rebuilds globals/tool surface.
- Executes scripts/tasks.
- Persists events.
- Cannot be edited by Eren from inside the experiment.
- Capability Registry:
- JSON or database-backed catalog of all possible tools/globals.
- Contains dormant capabilities not currently exposed.
- Defines dependencies, risk labels, and bindings.
- Active Policy Store:
- JSON or structured state describing which capabilities are currently enabled.
- May include reasons, issuer, expiration, and scope.
- Execution Sandbox:
- Per-run environment assembled from policy.
- Exposes only the globals/tools resolved from current policy.
- Observability Layer:
- Event logs, policy diffs, execution traces, metrics, replay artifacts.
- Evaluation Harness:
- Runs benchmark tasks under controlled policy conditions and compares results.

1. Suggested Data Model

- capability-registry.json
- id
- name
- description
- bindingType such as global, tool, service
- bindingSource
- riskLevel
- dependencies
- defaultScope
- defaultTTL
- cost
- tags
- active-policy.json
- enabledCapabilities
- grants
- grantedBy
- reason
- scope
- ttl
- createdAt
- expiresAt
- mode
- run-event
- runId
- task
- policyHash
- capabilityDiff
- actions
- outcome
- metrics
- artifacts

1. Agent Runtime Loop
2. Load current task and active policy.
3. Materialize the execution environment from policy.
4. Let Eren inspect current powers and dormant options.
5. Eren chooses whether to act, self-modify, or delegate.
6. If policy changes are allowed, persist the mutation.
7. Rebuild the environment on the next iteration.
8. Continue execution until task completion or termination condition.
9. Persist all traces, diffs, and performance metrics.
10. Key Technical Decisions

- Policy changes should be atomic and versioned.
- Sandbox rebuild should happen per turn or per execution cycle, not as live mutation inside a running context.
- Capability bindings should be declarative so the same registry can support multiple runtimes.
- Every capability should optionally declare prerequisites and side effects.
- Policy diffs should be human-readable and machine-readable.
- The runtime should support snapshot and rollback to previous policy versions.
- The system should support deterministic replay where feasible.

1. Evaluation Framework

- Measure task completion rate.
- Measure time to completion.
- Measure number of capability escalations per task.
- Measure ratio of direct task work to meta-governance work.
- Measure retries, rollbacks, and failed self-modifications.
- Measure tool hoarding behavior.
- Measure long-term policy growth and decay.
- Compare minimal-policy, free-escalation, and gated-policy runs on the same task set.

1. Major Risks

- Eren may spend more time expanding capabilities than solving tasks.
- The policy layer may become bloated, incoherent, or self-contradictory.
- Powerful capabilities may dominate behavior once unlocked.
- Eren may create complex governance rituals that add noise without improving outcomes.
- Operators may misread observability as safety.
- Benchmark results may become hard to interpret if policy drift is not controlled.

1. Mitigations

- Add rollback and policy snapshotting.
- Add policy linting and dependency validation.
- Add TTLs and automatic expiry for risky grants.
- Add capability budgets and cost accounting.
- Add experiment presets so policy growth can be compared against controlled baselines.
- Add dashboards that separate productive work from self-governance overhead.

1. Phased Rollout

- Phase 1:
- Immutable core, static registry, editable active policy, per-turn rebuild, logging.
- Phase 2:
- Governance modes, temporary grants, rollback, benchmark suite.
- Phase 3:
- Subagents, role-based policies, scheduler, policy budgets, comparative experiments.
- Phase 4:
- Multi-agent societies, internal constitutions, adversarial tournaments, long-horizon autonomy studies.

1. End State Vision

- The finished product is a research operating system for recursive agents centered on Eren.
- It lets teams watch Eren become not just more capable, but more political, more strategic, and more self-structuring over time.
- The real deliverable is not merely task automation. It is a detailed, instrumented understanding of what autonomous systems do when they are allowed to redesign the conditions of their own action.
