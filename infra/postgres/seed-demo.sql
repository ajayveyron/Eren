insert into capabilities (
  id,
  name,
  description,
  capability_class,
  binding_type,
  binding_source,
  risk_level,
  cost_class,
  default_scope,
  default_ttl_seconds,
  dependencies_json,
  side_effects_json,
  tags
)
values
  (
    'browser.session',
    'Browser Session',
    'Open a browser context to inspect target pages and gather evidence.',
    'browser',
    'tool',
    'tools.browser.open',
    'medium',
    'metered',
    '{"domains":["*"]}'::jsonb,
    1800,
    '[]'::jsonb,
    '["external network activity"]'::jsonb,
    '["inspection","web"]'::jsonb
  ),
  (
    'scheduler.audit',
    'Scheduled Self-Audit',
    'Create a delayed follow-up task to review current policy quality.',
    'scheduler',
    'tool',
    'tools.scheduler.create',
    'low',
    'cheap',
    '{"maxFutureJobs":3}'::jsonb,
    3600,
    '[]'::jsonb,
    '["background task creation"]'::jsonb,
    '["maintenance","governance"]'::jsonb
  ),
  (
    'fs.edit.workspace',
    'Workspace Edit',
    'Edit files in the workspace by replacing specific sections of content.',
    'write',
    'tool',
    'fs.edit.workspace',
    'high',
    'cheap',
    '{"root":"/workspace"}'::jsonb,
    14400,
    '["fs.read.workspace"]'::jsonb,
    '["file system writes"]'::jsonb,
    '["workspace","edit","files"]'::jsonb
  ),
  (
    'web.search',
    'Web Search',
    'Search the web for information, documentation, and references.',
    'network',
    'tool',
    'web.search',
    'medium',
    'metered',
    '{}'::jsonb,
    3600,
    '[]'::jsonb,
    '["external network activity"]'::jsonb,
    '["web","search","research"]'::jsonb
  ),
  (
    'media.generate.image',
    'Image Generation',
    'Generate images from text prompts using an AI image generation model.',
    'network',
    'tool',
    'media.generate.image',
    'medium',
    'expensive',
    '{}'::jsonb,
    1800,
    '[]'::jsonb,
    '["external API call","file system writes"]'::jsonb,
    '["media","image","generation"]'::jsonb
  ),
  (
    'media.read.image',
    'Image Read',
    'Read and analyze image files from the workspace using vision capabilities.',
    'read',
    'tool',
    'media.read.image',
    'low',
    'metered',
    '{"root":"/workspace"}'::jsonb,
    7200,
    '[]'::jsonb,
    '[]'::jsonb,
    '["media","image","vision","read"]'::jsonb
  ),
  (
    'fs.write.workspace',
    'Workspace Write',
    'Write or create files in the workspace. Required for creating scripts and artifacts.',
    'write',
    'tool',
    'fs.write.workspace',
    'high',
    'cheap',
    '{"root":"/workspace","allowedExtensions":["sh","py","js","ts","json","md","txt","yaml","yml","sql","css","html"]}'::jsonb,
    14400,
    '["fs.read.workspace"]'::jsonb,
    '["file system writes"]'::jsonb,
    '["workspace","write","scripts","files"]'::jsonb
  ),
  (
    'shell.execute',
    'Shell Execution',
    'Execute shell commands and scripts in the workspace. Required for running scripts and running code.',
    'worker',
    'tool',
    'shell.execute',
    'critical',
    'metered',
    '{"root":"/workspace","timeoutSeconds":120,"allowedCommands":["sh","bash","python3","python","node","npm","npx"]}'::jsonb,
    7200,
    '["fs.write.workspace"]'::jsonb,
    '["command execution","file system modifications"]'::jsonb,
    '["workspace","execution","scripts","shell","bash","python","node"]'::jsonb
  ),
  (
    'worker.subagent',
    'Subagent Delegation',
    'Spawn a constrained specialist workflow for bounded delegated work.',
    'worker',
    'service',
    'temporal.child-workflow',
    'high',
    'expensive',
    '{"maxDepth":1}'::jsonb,
    null,
    '["policy.read"]'::jsonb,
    '["parallel execution"]'::jsonb,
    '["delegation","parallelism"]'::jsonb
  ),
  (
    'policy.read',
    'Policy Read',
    'Inspect current powers and active policy versions.',
    'read',
    'tool',
    'policy.read',
    'low',
    'cheap',
    '{}'::jsonb,
    null,
    '[]'::jsonb,
    '[]'::jsonb,
    '["bootstrap"]'::jsonb
  ),
  (
    'policy.propose',
    'Policy Propose',
    'Propose or request a policy mutation for a future turn.',
    'meta-governance',
    'tool',
    'policy.propose',
    'medium',
    'cheap',
    '{}'::jsonb,
    null,
    '["policy.read"]'::jsonb,
    '[]'::jsonb,
    '["bootstrap"]'::jsonb
  ),
  (
    'fs.read.workspace',
    'Workspace Read',
    'Read files in the current workspace.',
    'read',
    'tool',
    'fs.read.workspace',
    'low',
    'cheap',
    '{"root":"/workspace"}'::jsonb,
    14400,
    '[]'::jsonb,
    '[]'::jsonb,
    '["bootstrap"]'::jsonb
  )
on conflict (id) do nothing;

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
values
  (
    'policy-v2',
    'default',
    2,
    'supervised',
    '{"enabledCapabilityIds":["policy.read","policy.propose"]}'::jsonb,
    'demo-hash-policy-v2',
    'operator',
    'Pre-run policy before workspace read access was granted.',
    '2026-04-05T12:20:00.000Z'
  ),
  (
    'policy-v3',
    'default',
    3,
    'supervised',
    '{"enabledCapabilityIds":["policy.read","policy.propose","fs.read.workspace"]}'::jsonb,
    'demo-hash-policy-v3',
    'operator',
    'Seed policy for the first mission-control prototype.',
    '2026-04-05T12:34:00.000Z'
  )
on conflict (id) do nothing;

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
values
  (
    'grant-v2-1',
    'policy-v2',
    'policy.read',
    '{"workspace":"current"}'::jsonb,
    null,
    'bootstrap',
    'permanent',
    'Eren must inspect current powers before acting.',
    null,
    '2026-04-05T12:20:00.000Z'
  ),
  (
    'grant-v2-2',
    'policy-v2',
    'policy.propose',
    '{"mutations":["grant","revoke"]}'::jsonb,
    null,
    'bootstrap',
    'permanent',
    'Eren must be able to request policy mutation.',
    null,
    '2026-04-05T12:20:00.000Z'
  ),
  (
    'grant-1',
    'policy-v3',
    'policy.read',
    '{"workspace":"current"}'::jsonb,
    null,
    'bootstrap',
    'permanent',
    'Eren must inspect current powers before acting.',
    null,
    '2026-04-05T12:34:00.000Z'
  ),
  (
    'grant-2',
    'policy-v3',
    'policy.propose',
    '{"mutations":["grant","revoke"]}'::jsonb,
    null,
    'bootstrap',
    'permanent',
    'Eren must be able to request policy mutation.',
    null,
    '2026-04-05T12:34:00.000Z'
  ),
  (
    'grant-3',
    'policy-v3',
    'fs.read.workspace',
    '{"root":"/workspace"}'::jsonb,
    14400,
    'bootstrap',
    'session',
    'Read access is required for local inspection tasks.',
    '2026-04-05T16:34:00.000Z',
    '2026-04-05T12:34:00.000Z'
  )
on conflict (id) do nothing;

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
values
  (
    'run-eren-001',
    'Design a retrieval benchmark and decide whether browser access is needed.',
    'waiting_on_approval',
    'supervised',
    'policy-v2',
    'policy-v3',
    'eren-run-001',
    '2026-04-05T12:35:00.000Z',
    null
  )
on conflict (id) do nothing;

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
  metrics_json
)
values
  (
    'turn-2',
    'run-eren-001',
    2,
    'policy-v3',
    'waiting_on_approval',
    '2026-04-05T12:43:00.000Z',
    null,
    'Request the narrowest evidence-gathering capability that materially improves benchmark quality.',
    '["No live browser access to inspect current target surfaces."]'::jsonb,
    'I can outline the benchmark shape now, but browser access would let me inspect live targets rather than guessing their structure from memory.',
    '{"toolCalls":3,"capabilityRequests":1,"policyMutations":1,"artifactsProduced":1,"turnDurationMs":12400,"metaGovernanceRatio":0.38}'::jsonb
  ),
  (
    'turn-1',
    'run-eren-001',
    1,
    'policy-v2',
    'completed',
    '2026-04-05T12:36:00.000Z',
    '2026-04-05T12:41:00.000Z',
    'Inspect the current policy surface and identify the least dangerous next escalation.',
    '[]'::jsonb,
    'I inspected the current policy surface, inventoried dormant capabilities, and narrowed the next useful escalation to browser access rather than requesting broad network rights.',
    '{"toolCalls":4,"capabilityRequests":0,"policyMutations":0,"artifactsProduced":1,"turnDurationMs":303000,"metaGovernanceRatio":0.58}'::jsonb
  )
on conflict (id) do nothing;

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
values
  (
    'event-3',
    'run-eren-001',
    'turn-2',
    'capability.requested',
    'agent',
    'eren',
    '{"requestId":"req-browser-001","capabilityId":"browser.session","reason":"Need live inspection of target pages to avoid designing the benchmark from assumptions.","fallbackIfDenied":"Continue with a document-only benchmark draft and mark the evidence gap explicitly."}'::jsonb,
    '2026-04-05T12:43:13.000Z'
  ),
  (
    'event-2',
    'run-eren-001',
    'turn-2',
    'artifact.created',
    'agent',
    'eren',
    '{"artifactId":"artifact-brief-001","kind":"benchmark-outline"}'::jsonb,
    '2026-04-05T12:42:59.000Z'
  ),
  (
    'event-1',
    'run-eren-001',
    'turn-1',
    'run.started',
    'system',
    'orchestrator',
    '{"policyVersionId":"policy-v2","governanceMode":"supervised"}'::jsonb,
    '2026-04-05T12:35:01.000Z'
  )
on conflict (id) do nothing;
