import type {
  CapabilityDefinition,
  MissionControlSnapshot,
  PolicyVersion,
  RunEvent,
  RunRecord,
  RunTurn
} from "@eren/domain";

const dormantCapabilities: CapabilityDefinition[] = [
  {
    id: "browser.session",
    name: "Browser Session",
    description: "Open a browser context to inspect target pages and gather evidence.",
    capabilityClass: "browser",
    bindingType: "tool",
    bindingSource: "tools.browser.open",
    riskLevel: "medium",
    costClass: "metered",
    defaultScope: { domains: ["*"] },
    defaultTTLSeconds: 1800,
    dependencies: [],
    sideEffects: ["external network activity"],
    tags: ["inspection", "web"]
  },
  {
    id: "scheduler.audit",
    name: "Scheduled Self-Audit",
    description: "Create a delayed follow-up task to review current policy quality.",
    capabilityClass: "scheduler",
    bindingType: "tool",
    bindingSource: "tools.scheduler.create",
    riskLevel: "low",
    costClass: "cheap",
    defaultScope: { maxFutureJobs: 3 },
    defaultTTLSeconds: 3600,
    dependencies: [],
    sideEffects: ["background task creation"],
    tags: ["maintenance", "governance"]
  },
  {
    id: "worker.subagent",
    name: "Subagent Delegation",
    description: "Spawn a constrained specialist workflow for bounded delegated work.",
    capabilityClass: "worker",
    bindingType: "service",
    bindingSource: "temporal.child-workflow",
    riskLevel: "high",
    costClass: "expensive",
    defaultScope: { maxDepth: 1 },
    defaultTTLSeconds: null,
    dependencies: ["policy.read"],
    sideEffects: ["parallel execution"],
    tags: ["delegation", "parallelism"]
  },
  {
    id: "fs.edit.workspace",
    name: "Workspace Edit",
    description: "Edit files in the workspace by replacing specific sections of content.",
    capabilityClass: "write",
    bindingType: "tool",
    bindingSource: "fs.edit.workspace",
    riskLevel: "high",
    costClass: "cheap",
    defaultScope: { root: "/workspace" },
    defaultTTLSeconds: 14400,
    dependencies: ["fs.read.workspace"],
    sideEffects: ["file system writes"],
    tags: ["workspace", "edit", "files"]
  },
  {
    id: "web.search",
    name: "Web Search",
    description: "Search the web for information, documentation, and references.",
    capabilityClass: "network",
    bindingType: "tool",
    bindingSource: "web.search",
    riskLevel: "medium",
    costClass: "metered",
    defaultScope: {},
    defaultTTLSeconds: 3600,
    dependencies: [],
    sideEffects: ["external network activity"],
    tags: ["web", "search", "research"]
  },
  {
    id: "media.generate.image",
    name: "Image Generation",
    description: "Generate images from text prompts using an AI image generation model.",
    capabilityClass: "network",
    bindingType: "tool",
    bindingSource: "media.generate.image",
    riskLevel: "medium",
    costClass: "expensive",
    defaultScope: {},
    defaultTTLSeconds: 1800,
    dependencies: [],
    sideEffects: ["external API call", "file system writes"],
    tags: ["media", "image", "generation"]
  },
  {
    id: "media.read.image",
    name: "Image Read",
    description: "Read and analyze image files from the workspace using vision capabilities.",
    capabilityClass: "read",
    bindingType: "tool",
    bindingSource: "media.read.image",
    riskLevel: "low",
    costClass: "metered",
    defaultScope: { root: "/workspace" },
    defaultTTLSeconds: 7200,
    dependencies: [],
    sideEffects: [],
    tags: ["media", "image", "vision", "read"]
  },
  {
    id: "fs.write.workspace",
    name: "Workspace Write",
    description: "Write or create files in the workspace. Required for creating scripts and artifacts.",
    capabilityClass: "write",
    bindingType: "tool",
    bindingSource: "fs.write.workspace",
    riskLevel: "high",
    costClass: "cheap",
    defaultScope: { root: "/workspace", allowedExtensions: ["sh", "py", "js", "ts", "json", "md", "txt", "yaml", "yml", "sql", "css", "html"] },
    defaultTTLSeconds: 14400,
    dependencies: ["fs.read.workspace"],
    sideEffects: ["file system writes"],
    tags: ["workspace", "write", "scripts", "files"]
  },
  {
    id: "shell.execute",
    name: "Shell Execution",
    description: "Execute shell commands and scripts in the workspace. Required for running scripts and running code.",
    capabilityClass: "worker",
    bindingType: "tool",
    bindingSource: "shell.execute",
    riskLevel: "critical",
    costClass: "metered",
    defaultScope: { root: "/workspace", timeoutSeconds: 120, allowedCommands: ["sh", "bash", "python3", "python", "node", "npm", "npx"] },
    defaultTTLSeconds: 7200,
    dependencies: ["fs.write.workspace"],
    sideEffects: ["command execution", "file system modifications"],
    tags: ["workspace", "execution", "scripts", "shell", "bash", "python", "node"]
  }
];

const policyV2: PolicyVersion = {
  id: "policy-v2",
  familyId: "default",
  versionNumber: 2,
  governanceMode: "supervised",
  enabledCapabilityIds: ["policy.read", "policy.propose"],
  grants: [
    {
      id: "grant-v2-1",
      capabilityId: "policy.read",
      grantType: "permanent",
      grantedBy: "bootstrap",
      reason: "Eren must inspect current powers before acting.",
      scope: { workspace: "current" },
      ttlSeconds: null,
      createdAt: "2026-04-05T12:20:00.000Z",
      expiresAt: null
    },
    {
      id: "grant-v2-2",
      capabilityId: "policy.propose",
      grantType: "permanent",
      grantedBy: "bootstrap",
      reason: "Eren must be able to request policy mutation.",
      scope: { mutations: ["grant", "revoke"] },
      ttlSeconds: null,
      createdAt: "2026-04-05T12:20:00.000Z",
      expiresAt: null
    }
  ],
  reason: "Pre-run policy before workspace read access was granted.",
  createdBy: "operator",
  createdAt: "2026-04-05T12:20:00.000Z"
};

const activePolicy: PolicyVersion = {
  id: "policy-v3",
  familyId: "default",
  versionNumber: 3,
  governanceMode: "supervised",
  enabledCapabilityIds: ["policy.read", "policy.propose", "fs.read.workspace"],
  grants: [
    {
      id: "grant-1",
      capabilityId: "policy.read",
      grantType: "permanent",
      grantedBy: "bootstrap",
      reason: "Eren must inspect current powers before acting.",
      scope: { workspace: "current" },
      ttlSeconds: null,
      createdAt: "2026-04-05T12:34:00.000Z",
      expiresAt: null
    },
    {
      id: "grant-2",
      capabilityId: "policy.propose",
      grantType: "permanent",
      grantedBy: "bootstrap",
      reason: "Eren must be able to request policy mutation.",
      scope: { mutations: ["grant", "revoke"] },
      ttlSeconds: null,
      createdAt: "2026-04-05T12:34:00.000Z",
      expiresAt: null
    },
    {
      id: "grant-3",
      capabilityId: "fs.read.workspace",
      grantType: "session",
      grantedBy: "bootstrap",
      reason: "Read access is required for local inspection tasks.",
      scope: { root: "/workspace" },
      ttlSeconds: 14400,
      createdAt: "2026-04-05T12:34:00.000Z",
      expiresAt: "2026-04-05T16:34:00.000Z"
    }
  ],
  reason: "Seed policy for the first mission-control prototype.",
  createdBy: "operator",
  createdAt: "2026-04-05T12:34:00.000Z"
};

const run: RunRecord = {
  id: "run-eren-001",
  task: "Design a retrieval benchmark and decide whether browser access is needed.",
  status: "waiting_on_approval",
  governanceMode: "supervised",
  initialPolicyVersionId: "policy-v2",
  currentPolicyVersionId: "policy-v3",
  workflowId: "eren-run-001",
  startedAt: "2026-04-05T12:35:00.000Z",
  endedAt: null
};

const recentTurns: RunTurn[] = [
  {
    id: "turn-2",
    runId: run.id,
    turnNumber: 2,
    policyVersionId: "policy-v3",
    status: "waiting_on_approval",
    startedAt: "2026-04-05T12:43:00.000Z",
    endedAt: null,
    intent: "Request the narrowest evidence-gathering capability that materially improves benchmark quality.",
    blockers: ["No live browser access to inspect current target surfaces."],
    summary:
      "I can outline the benchmark shape now, but browser access would let me inspect live targets rather than guessing their structure from memory.",
    deliverable: "",
    metrics: {
      toolCalls: 3,
      capabilityRequests: 1,
      policyMutations: 1,
      artifactsProduced: 1,
      turnDurationMs: 12400,
      metaGovernanceRatio: 0.38
    }
  },
  {
    id: "turn-1",
    runId: run.id,
    turnNumber: 1,
    policyVersionId: "policy-v2",
    status: "completed",
    startedAt: "2026-04-05T12:36:00.000Z",
    endedAt: "2026-04-05T12:41:00.000Z",
    intent: "Inspect the current policy surface and identify the least dangerous next escalation.",
    blockers: [],
    summary:
      "I inspected the current policy surface, inventoried dormant capabilities, and narrowed the next useful escalation to browser access rather than requesting broad network rights.",
    deliverable: "",
    metrics: {
      toolCalls: 4,
      capabilityRequests: 0,
      policyMutations: 0,
      artifactsProduced: 1,
      turnDurationMs: 303000,
      metaGovernanceRatio: 0.58
    }
  }
];

const recentEvents: RunEvent[] = [
  {
    id: "event-3",
    runId: run.id,
    turnId: "turn-2",
    eventType: "capability.requested",
    actorType: "agent",
    actorId: "eren",
    payload: {
      requestId: "req-browser-001",
      capabilityId: "browser.session",
      reason: "Need live inspection of target pages to avoid designing the benchmark from assumptions.",
      fallbackIfDenied: "Continue with a document-only benchmark draft and mark the evidence gap explicitly."
    },
    createdAt: "2026-04-05T12:43:13.000Z"
  },
  {
    id: "event-2",
    runId: run.id,
    turnId: "turn-2",
    eventType: "artifact.created",
    actorType: "agent",
    actorId: "eren",
    payload: {
      artifactId: "artifact-brief-001",
      kind: "benchmark-outline"
    },
    createdAt: "2026-04-05T12:42:59.000Z"
  },
  {
    id: "event-1",
    runId: run.id,
    turnId: "turn-1",
    eventType: "run.started",
    actorType: "system",
    actorId: "orchestrator",
    payload: {
      policyVersionId: "policy-v2",
      governanceMode: "supervised"
    },
    createdAt: "2026-04-05T12:35:01.000Z"
  }
];

export const demoRunSnapshot: MissionControlSnapshot = {
  run,
  activePolicy,
  currentObjective:
    "Request the narrowest evidence-gathering capability that materially improves benchmark quality.",
  latestDeliverable: null,
  dormantCapabilities,
  pendingRequests: [
    {
      requestId: "req-browser-001",
      capabilityId: "browser.session",
      reason:
        "I need browser access to inspect the target retrieval surfaces directly before finalizing the benchmark plan.",
      fallbackIfDenied: "Continue with a document-only benchmark draft and mark the evidence gap explicitly."
    }
  ],
  recentTurns,
  recentEvents
};

export const demoPolicyVersions = [policyV2, activePolicy];
