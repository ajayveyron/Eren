create table if not exists capabilities (
  id text primary key,
  name text not null,
  description text not null,
  capability_class text not null,
  binding_type text not null,
  binding_source text not null,
  risk_level text not null,
  cost_class text not null,
  default_scope jsonb not null default '{}'::jsonb,
  default_ttl_seconds integer,
  dependencies_json jsonb not null default '[]'::jsonb,
  side_effects_json jsonb not null default '[]'::jsonb,
  tags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists policy_versions (
  id text primary key,
  policy_family_id text not null,
  version_number integer not null,
  governance_mode text not null,
  policy_json jsonb not null,
  policy_hash text not null,
  created_by text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  unique (policy_family_id, version_number)
);

create table if not exists policy_grants (
  id text primary key,
  policy_version_id text not null references policy_versions(id) on delete cascade,
  capability_id text not null references capabilities(id),
  scope_json jsonb not null default '{}'::jsonb,
  ttl_seconds integer,
  granted_by text not null,
  grant_type text not null,
  reason text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists runs (
  id text primary key,
  task text not null,
  status text not null,
  governance_mode text not null,
  initial_policy_version_id text not null references policy_versions(id) on delete restrict,
  current_policy_version_id text not null references policy_versions(id) on delete restrict,
  workflow_id text not null unique,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists run_turns (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  turn_number integer not null,
  policy_version_id text not null references policy_versions(id),
  status text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  intent text not null,
  blockers_json jsonb not null default '[]'::jsonb,
  summary text not null,
  deliverable text not null default '',
  metrics_json jsonb not null default '{}'::jsonb,
  unique (run_id, turn_number)
);

create table if not exists run_events (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  turn_id text references run_turns(id) on delete cascade,
  event_type text not null,
  actor_type text not null,
  actor_id text not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_run_events_run_id_created_at
  on run_events (run_id, created_at desc);

create table if not exists policy_events (
  id text primary key,
  run_id text references runs(id) on delete cascade,
  policy_version_id text not null references policy_versions(id) on delete cascade,
  event_type text not null,
  diff_json jsonb not null default '{}'::jsonb,
  reason text not null,
  created_at timestamptz not null default now()
);

create table if not exists artifacts (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  turn_id text references run_turns(id) on delete set null,
  artifact_type text not null,
  path_or_url text not null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_run_turns_run_id_turn_number
  on run_turns (run_id, turn_number);

create index if not exists idx_policy_events_run_id_event_type
  on policy_events (run_id, event_type);

create index if not exists idx_policy_grants_policy_version_id
  on policy_grants (policy_version_id);

create index if not exists idx_artifacts_run_id
  on artifacts (run_id);

create table if not exists agent_defined_capabilities (
  id text primary key,
  run_id text not null references runs(id) on delete cascade,
  name text not null,
  description text not null,
  parameter_schema_json jsonb not null default '{}'::jsonb,
  script_path text not null,
  script_language text not null,
  risk_level text not null default 'high',
  status text not null default 'pending',
  defined_by text not null default 'eren',
  approved_by text,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_defined_capabilities_run_id_status
  on agent_defined_capabilities (run_id, status);
