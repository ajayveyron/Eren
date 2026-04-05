# Eren

Eren is a research operating system for observing a self-modifying agent whose capability surface can change across turns.

This repository now contains the first implementation scaffold for the architecture described in:

- [prd.md](./prd.md)
- [architecture.md](./architecture.md)

## Current Shape

- `apps/web`
  - Next.js App Router shell for the mission-control UI
- `packages/domain`
  - shared types and schemas for capabilities, policies, runs, events, and turn results
- `packages/temporal`
  - Temporal workflow and activity boundaries for Eren's durable run loop
- `packages/persistence`
  - repository implementations for demo mode and Postgres-backed data access
- `infra/postgres`
  - first-pass SQL schema aligned with the architecture plan
  - `seed-demo.sql` for a demo run that matches the current UI and workflow placeholder

## What Exists Today

- a workspace scaffold
- a typed domain model
- a Temporal `RunWorkflow` skeleton with approval and pause/resume signals
- a repository layer that can serve mission-control snapshots from demo data or Postgres
- a minimal mission-control interface that reflects the intended product shape
- API routes for run creation and workflow control
- operator controls for pause, resume, note injection, and grant approval or denial
- an initial Postgres schema for capabilities, policies, runs, events, and artifacts

## What Does Not Exist Yet

- actual Temporal activity implementations
- real model/tool execution beyond the current placeholder `runTurn`
- authentication, access control, or production deployment wiring

## Environment

Current runtime expectations:

- `.env.example`
  - local template for the current runtime variables
- `DATABASE_URL`
  - required for creating new runs and persisting data outside demo mode
- `TEMPORAL_ADDRESS`
  - required for starting workflows and sending control signals
- `TEMPORAL_NAMESPACE`
  - optional
- `TEMPORAL_TASK_QUEUE`
  - optional, defaults to `eren-run-queue`

## Local Boot

Once Postgres and Temporal are running and `.env` exists at the repo root:

1. `npm run db:setup`
2. `npm run dev:web`
3. `npm run dev:worker`

`db:setup` applies `infra/postgres/schema.sql` and `infra/postgres/seed-demo.sql` to the `DATABASE_URL` from your repo-root `.env`.

## Recommended Next Steps

1. install dependencies
2. install Postgres locally or provision a remote database and apply `infra/postgres/schema.sql`
3. optionally load `infra/postgres/seed-demo.sql` to mirror the current demo snapshot in SQL
4. replace the placeholder `runTurn` activity with a model/tool runtime
5. add run creation and operator approval flows
6. replace the demo-seeded UI with live projections and mutations end-to-end

No installs or builds were run as part of this scaffold.
