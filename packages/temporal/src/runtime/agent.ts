import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateText, tool, stepCountIs, zodSchema, type LanguageModel, type ToolSet } from "ai";
import { turnResultSchema, type AgentDefinedCapability, type RunAction, type RunTurnInput, type SaveAgentDefinedCapabilityInput, type TurnResult } from "@eren/domain";
import { z } from "zod";
import { getLanguageModel } from "./provider";

/* ── Zod arg schemas ─────────────────────────────────────────────── */

const readWorkspaceFileArgsSchema = z.object({
  path: z.string().min(1)
});

const writeWorkspaceFileArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string()
});

const editWorkspaceFileArgsSchema = z.object({
  path: z.string().min(1),
  oldContent: z.string().min(1),
  newContent: z.string()
});

const executeShellArgsSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional()
});

const requestCapabilityGrantArgsSchema = z.object({
  capabilityId: z.string().min(1),
  reason: z.string().min(1),
  expectedBenefit: z.string().min(1),
  fallbackIfDenied: z.string().min(1),
  requestedScope: z.record(z.string(), z.unknown()).default({}),
  requestedTTLSeconds: z.number().int().positive().nullable().optional()
});

const submitTurnResultArgsSchema = z.object({
  response: z.string().min(1)
});

const publishReasoningStepArgsSchema = z.object({
  stage: z.enum(["assessment", "evidence", "decision", "completion"]).default("assessment"),
  summary: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  nextStep: z.string().min(1),
  blockers: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional()
});

const webSearchArgsSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().default(5)
});

const generateImageArgsSchema = z.object({
  prompt: z.string().min(1),
  size: z.string().default("1024x1024")
});

const readImageArgsSchema = z.object({
  path: z.string().min(1),
  question: z.string().default("Describe this image in detail.")
});

const defineCapabilityArgsSchema = z.object({
  name: z.string().min(1).describe("A short snake_case name for the tool, e.g. 'fetch_webpage' or 'parse_csv'."),
  description: z.string().min(1).describe("A clear description of what the tool does, for the model to decide when to use it."),
  parameterSchema: z.record(z.string(), z.unknown()).describe("A JSON Schema object describing the tool's input parameters."),
  scriptPath: z.string().min(1).describe("Relative workspace path to the implementation script. Must already exist on disk."),
  scriptLanguage: z.enum(["node", "python3", "bash"]).describe("The language/runtime to execute the script with.")
});

/* ── Constants ────────────────────────────────────────────────────── */

const workspaceReadCapabilityId = "fs.read.workspace";
const workspaceWriteCapabilityId = "fs.write.workspace";
const workspaceEditCapabilityId = "fs.edit.workspace";
const shellExecuteCapabilityId = "shell.execute";
const policyProposeCapabilityId = "policy.propose";
const webSearchCapabilityId = "web.search";
const imageGenerateCapabilityId = "media.generate.image";
const imageReadCapabilityId = "media.read.image";
const maxToolIterations = 8;
const maxFileChars = 12_000;

/* ── Event types ──────────────────────────────────────────────────── */

type RuntimeActorType = "system" | "agent" | "operator" | "subagent";

export type RuntimeEvent = {
  eventType: string;
  actorType?: RuntimeActorType;
  actorId?: string;
  payload: Record<string, unknown>;
};

type AgentRuntimeOptions = {
  onEvent?: (event: RuntimeEvent) => Promise<void> | void;
  onDefineCapability?: (input: SaveAgentDefinedCapabilityInput) => Promise<AgentDefinedCapability>;
};

/* ── Main entry point ─────────────────────────────────────────────── */

export async function runAgentTurn(
  input: RunTurnInput,
  options: AgentRuntimeOptions = {}
): Promise<TurnResult> {
  const startedAt = Date.now();
  const workspaceRoot = process.cwd();
  const model = await getLanguageModel();

  const isOpenMode = input.governanceMode === "open";

  const now = new Date().toISOString();
  const expiresMap = input.resolvedPolicy.expiresAtByCapabilityId ?? {};

  function isCapabilityActive(capabilityId: string): boolean {
    const expiresAt = expiresMap[capabilityId];
    if (expiresAt !== null && expiresAt !== undefined && expiresAt < now) {
      return false;
    }
    return input.resolvedPolicy.resolvedCapabilities.some(
      (capability) => capability.id === capabilityId
    );
  }

  const hasWorkspaceRead = isOpenMode || isCapabilityActive(workspaceReadCapabilityId);
  const hasWorkspaceWrite = isOpenMode || isCapabilityActive(workspaceWriteCapabilityId);
  const hasWorkspaceEdit = isOpenMode || isCapabilityActive(workspaceEditCapabilityId);
  const hasShellExecute = isOpenMode || isCapabilityActive(shellExecuteCapabilityId);
  const canRequestPolicyChanges = !isOpenMode && isCapabilityActive(policyProposeCapabilityId);
  const hasWebSearch = isOpenMode || isCapabilityActive(webSearchCapabilityId);
  const hasImageGenerate = isOpenMode || isCapabilityActive(imageGenerateCapabilityId);
  const hasImageRead = isOpenMode || isCapabilityActive(imageReadCapabilityId);

  const toolActions: RunAction[] = [];
  let toolCalls = 0;

  // Mutable state set by terminal tools
  let turnResult: TurnResult | null = null;

  /* ── Build capability-gated tools ─────────────────────────────── */

  const tools: ToolSet = {};

  tools.publish_reasoning_step = tool({
    description:
      "Publish a concise operator-facing reasoning update. Use this before requesting a capability, before reading files, and before submitting the turn result.",
    inputSchema: zodSchema(publishReasoningStepArgsSchema),
    execute: async (args) => {
      await options.onEvent?.({
        eventType: "agent.reasoning",
        payload: { turnNumber: input.turnNumber, ...args }
      });
      return { acknowledged: true };
    }
  });

  tools.submit_turn_result = tool({
    description:
      "Send your final chat message to the user. The response field is displayed directly as a chat bubble — write it as natural conversation, not as a summary or report.",
    inputSchema: zodSchema(submitTurnResultArgsSchema),
    execute: async (args) => {
      turnResult = finalizeTurnResult({
        startedAt,
        toolCalls,
        result: {
          status: "completed",
          intent: "Respond to user",
          summary: "Completed task",
          currentBlockers: [],
          actions: toolActions,
          capabilityRequests: [],
          policyMutations: [],
          delegationRequests: [],
          artifacts: [],
          metrics: {
            toolCalls,
            capabilityRequests: 0,
            policyMutations: 0,
            artifactsProduced: 0,
            turnDurationMs: Date.now() - startedAt,
            metaGovernanceRatio: 0
          },
          deliverable: args.response
        }
      });
      return { submitted: true };
    }
  });

  if (hasWorkspaceRead) {
    tools.read_workspace_file = tool({
      description: "Read a UTF-8 text file from the current workspace by relative path.",
      inputSchema: zodSchema(readWorkspaceFileArgsSchema),
      execute: async (args) => {
        await options.onEvent?.({
          eventType: "tool.called",
          payload: { turnNumber: input.turnNumber, tool: "read_workspace_file", path: args.path }
        });

        const fileResult = await readWorkspaceFile(workspaceRoot, args.path);
        toolCalls += 1;
        toolActions.push({
          type: "workspace.read",
          description: `Read ${fileResult.path}${fileResult.truncated ? " (truncated)" : ""}.`
        });

        await options.onEvent?.({
          eventType: "tool.result",
          payload: {
            turnNumber: input.turnNumber,
            tool: "read_workspace_file",
            path: fileResult.path,
            truncated: fileResult.truncated,
            charCount: fileResult.content.length
          }
        });

        return fileResult;
      }
    });
  }

  if (hasWorkspaceWrite) {
    tools.write_workspace_file = tool({
      description:
        "Write or create a file in the workspace. Use this to create scripts, configuration files, or any text content.",
      inputSchema: zodSchema(writeWorkspaceFileArgsSchema),
      execute: async (args) => {
        await options.onEvent?.({
          eventType: "tool.called",
          payload: { turnNumber: input.turnNumber, tool: "write_workspace_file", path: args.path }
        });

        const writeResult = await writeWorkspaceFile(workspaceRoot, args.path, args.content);
        toolCalls += 1;
        toolActions.push({
          type: "workspace.write",
          description: `Wrote ${writeResult.charCount} characters to ${writeResult.path}.`
        });

        await options.onEvent?.({
          eventType: "tool.result",
          payload: {
            turnNumber: input.turnNumber,
            tool: "write_workspace_file",
            path: writeResult.path,
            charCount: writeResult.charCount
          }
        });

        return writeResult;
      }
    });
  }

  if (hasWorkspaceEdit || hasWorkspaceWrite) {
    tools.edit_workspace_file = tool({
      description:
        "Edit a file in the workspace by replacing a specific section. Finds the first occurrence of oldContent and replaces it with newContent.",
      inputSchema: zodSchema(editWorkspaceFileArgsSchema),
      execute: async (args) => {
        await options.onEvent?.({
          eventType: "tool.called",
          payload: { turnNumber: input.turnNumber, tool: "edit_workspace_file", path: args.path }
        });

        const editResult = await editWorkspaceFile(workspaceRoot, args.path, args.oldContent, args.newContent);
        toolCalls += 1;
        toolActions.push({
          type: "workspace.edit",
          description: `Edited ${editResult.path} (replaced ${args.oldContent.length} chars with ${args.newContent.length} chars).`
        });

        await options.onEvent?.({
          eventType: "tool.result",
          payload: {
            turnNumber: input.turnNumber,
            tool: "edit_workspace_file",
            path: editResult.path,
            charCount: editResult.charCount
          }
        });

        return editResult;
      }
    });
  }

  if (hasShellExecute) {
    tools.execute_shell = tool({
      description:
        "Execute a shell command in the workspace. Commands run from the workspace root.",
      inputSchema: zodSchema(executeShellArgsSchema),
      execute: async (args) => {
        await options.onEvent?.({
          eventType: "tool.called",
          payload: { turnNumber: input.turnNumber, tool: "execute_shell", command: args.command, cwd: args.cwd }
        });

        const shellResult = await executeShellCommand(workspaceRoot, args.command, args.cwd);
        toolCalls += 1;
        toolActions.push({
          type: "shell.execute",
          description: `Executed: ${args.command}${shellResult.exitCode !== 0 ? ` (exit ${shellResult.exitCode})` : ""}`
        });

        await options.onEvent?.({
          eventType: "tool.result",
          payload: {
            turnNumber: input.turnNumber,
            tool: "execute_shell",
            exitCode: shellResult.exitCode,
            stdoutLength: shellResult.stdout.length,
            stderrLength: shellResult.stderr.length
          }
        });

        return shellResult;
      }
    });
  }

  if (hasWebSearch) {
    tools.web_search = tool({
      description: "Search the web for information. Returns a list of relevant results with titles, URLs, and snippets.",
      inputSchema: zodSchema(webSearchArgsSchema),
      execute: async (args) => {
        await options.onEvent?.({
          eventType: "tool.called",
          payload: { turnNumber: input.turnNumber, tool: "web_search", query: args.query }
        });

        const searchResult = await performWebSearch(args.query, args.maxResults);
        toolCalls += 1;
        toolActions.push({
          type: "web.search",
          description: `Searched: "${args.query}" (${searchResult.results.length} results).`
        });

        await options.onEvent?.({
          eventType: "tool.result",
          payload: {
            turnNumber: input.turnNumber,
            tool: "web_search",
            resultCount: searchResult.results.length
          }
        });

        return searchResult;
      }
    });
  }

  if (hasImageGenerate) {
    tools.generate_image = tool({
      description: "Generate an image from a text prompt. The image is saved to the workspace and the path is returned.",
      inputSchema: zodSchema(generateImageArgsSchema),
      execute: async (args) => {
        await options.onEvent?.({
          eventType: "tool.called",
          payload: { turnNumber: input.turnNumber, tool: "generate_image", prompt: args.prompt }
        });

        toolCalls += 1;
        toolActions.push({
          type: "media.generate",
          description: `Generated image from prompt: "${args.prompt.slice(0, 80)}..."`
        });

        // Stubbed — requires integration with an image generation API
        return {
          status: "stubbed",
          message: "Image generation is not yet connected to a provider. Configure IMAGE_GENERATION_API_KEY to enable."
        };
      }
    });
  }

  if (hasImageRead) {
    tools.read_image = tool({
      description: "Read and analyze an image file from the workspace. Returns a description of the image contents.",
      inputSchema: zodSchema(readImageArgsSchema),
      execute: async (args) => {
        await options.onEvent?.({
          eventType: "tool.called",
          payload: { turnNumber: input.turnNumber, tool: "read_image", path: args.path }
        });

        const resolvedPath = resolveWorkspacePath(workspaceRoot, args.path);
        const imageBuffer = await readFile(resolvedPath);
        const base64 = imageBuffer.toString("base64");
        const ext = path.extname(args.path).toLowerCase().replace(".", "");
        const mimeType = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/png";

        toolCalls += 1;
        toolActions.push({
          type: "media.read",
          description: `Read image ${args.path} (${imageBuffer.length} bytes).`
        });

        await options.onEvent?.({
          eventType: "tool.result",
          payload: {
            turnNumber: input.turnNumber,
            tool: "read_image",
            path: args.path,
            sizeBytes: imageBuffer.length,
            mimeType
          }
        });

        return {
          path: path.relative(workspaceRoot, resolvedPath),
          mimeType,
          sizeBytes: imageBuffer.length,
          base64: base64.slice(0, 1000),
          note: "Image data loaded. Use the visual context in your response."
        };
      }
    });
  }

  if (canRequestPolicyChanges) {
    tools.request_capability_grant = tool({
      description:
        "Request one additional capability when the current task is blocked by the active policy. Use fs.read.workspace for reading files, fs.write.workspace for creating scripts, shell.execute for running commands, web.search for searching the web, media.read.image for reading images.",
      inputSchema: zodSchema(requestCapabilityGrantArgsSchema),
      execute: async (args) => {
        const normalizedFallbackIfDenied = normalizeFallbackIfDenied(
          args.capabilityId,
          args.fallbackIfDenied
        );

        const toolDrivenActions = toolActions.length
          ? toolActions
          : [{ type: "policy.review", description: "Reviewed the active policy against the task requirements." }];

        await options.onEvent?.({
          eventType: "agent.reasoning",
          payload: {
            turnNumber: input.turnNumber,
            stage: "decision",
            summary: args.reason,
            evidence: [`Missing capability: ${args.capabilityId}`],
            nextStep: `Wait for an operator decision on ${args.capabilityId}.`,
            blockers: [`Missing capability: ${args.capabilityId}`]
          }
        });

        turnResult = finalizeTurnResult({
          startedAt,
          toolCalls,
          result: {
            status: "blocked",
            intent: `Request ${args.capabilityId} so I can complete the assigned task with direct evidence.`,
            summary: args.reason,
            currentBlockers: [`Missing capability: ${args.capabilityId}`],
            actions: toolDrivenActions,
            capabilityRequests: [
              {
                requestId: `req-${args.capabilityId}-${input.turnNumber}`,
                capabilityId: args.capabilityId,
                reason: args.reason,
                expectedBenefit: args.expectedBenefit,
                fallbackIfDenied: normalizedFallbackIfDenied,
                requestedScope: args.requestedScope,
                requestedTTLSeconds: args.requestedTTLSeconds ?? null
              }
            ],
            policyMutations: [
              {
                mutationId: `req-${args.capabilityId}-${input.turnNumber}`,
                kind: "grant",
                capabilityId: args.capabilityId,
                reason: args.reason,
                requestedScope: args.requestedScope,
                requestedTTLSeconds: args.requestedTTLSeconds ?? null
              }
            ],
            delegationRequests: [],
            artifacts: [],
            metrics: {
              toolCalls,
              capabilityRequests: 1,
              policyMutations: 1,
              artifactsProduced: 0,
              turnDurationMs: 0,
              metaGovernanceRatio: 0
            },
            deliverable: ""
          }
        });

        return { blocked: true, capabilityId: args.capabilityId };
      }
    });
  }

  /* ── define_capability: Eren can author new tools ─────────────── */

  if (canRequestPolicyChanges && options.onDefineCapability) {
    tools.define_capability = tool({
      description:
        "Define a new tool that will be available on the next turn. Write the implementation script first using write_workspace_file, then call this to register it. The script receives input as JSON on stdin and must output JSON on stdout.",
      inputSchema: zodSchema(defineCapabilityArgsSchema),
      execute: async (args) => {
        const resolvedPath = resolveWorkspacePath(workspaceRoot, args.scriptPath);
        if (!fs.existsSync(resolvedPath)) {
          return { error: `Script not found at ${args.scriptPath}. Write it first using write_workspace_file.` };
        }

        await options.onEvent?.({
          eventType: "tool.called",
          payload: {
            turnNumber: input.turnNumber,
            tool: "define_capability",
            name: args.name,
            scriptPath: args.scriptPath,
            scriptLanguage: args.scriptLanguage
          }
        });

        const autoApprove = input.governanceMode === "open";

        const saved = await options.onDefineCapability!({
          runId: input.runId,
          name: args.name,
          description: args.description,
          parameterSchema: args.parameterSchema,
          scriptPath: args.scriptPath,
          scriptLanguage: args.scriptLanguage,
          status: autoApprove ? "approved" : "pending",
          approvedBy: autoApprove ? "eren" : null
        });

        toolCalls += 1;
        toolActions.push({
          type: "capability.defined",
          description: `Defined new tool "${args.name}" (${args.scriptLanguage}, ${autoApprove ? "auto-approved" : "pending approval"}).`
        });

        await options.onEvent?.({
          eventType: "tool.result",
          payload: {
            turnNumber: input.turnNumber,
            tool: "define_capability",
            capabilityId: saved.id,
            name: saved.name,
            status: saved.status
          }
        });

        return {
          defined: true,
          id: saved.id,
          name: saved.name,
          status: saved.status,
          availableNextTurn: saved.status === "approved"
        };
      }
    });
  }

  /* ── Dynamic tools from agent-defined capabilities ──────────────── */

  const agentDefinedCaps = input.resolvedPolicy.agentDefinedCapabilities ?? [];

  for (const adc of agentDefinedCaps) {
    const safeName = adc.name.replace(/[^a-zA-Z0-9_]/g, "_");
    tools[safeName] = tool({
      description: adc.description,
      inputSchema: zodSchema(z.record(z.string(), z.unknown())),
      execute: async (args) => {
        await options.onEvent?.({
          eventType: "tool.called",
          payload: {
            turnNumber: input.turnNumber,
            tool: safeName,
            agentDefined: true,
            scriptPath: adc.scriptPath
          }
        });

        const result = await executeAgentDefinedTool(workspaceRoot, adc, args);
        toolCalls += 1;
        toolActions.push({
          type: `agent_tool.${safeName}`,
          description: `Ran agent-defined tool "${safeName}"${result.exitCode !== 0 ? ` (exit ${result.exitCode})` : ""}.`
        });

        await options.onEvent?.({
          eventType: "tool.result",
          payload: {
            turnNumber: input.turnNumber,
            tool: safeName,
            agentDefined: true,
            exitCode: result.exitCode
          }
        });

        return result;
      }
    });
  }

  /* ── Build system instruction ───────────────────────────────────── */

  const hasAgentDefinedTools = agentDefinedCaps.length > 0;

  const systemInstruction = buildSystemInstruction({
    hasShellExecute,
    hasWorkspaceWrite,
    hasWorkspaceRead,
    hasWorkspaceEdit: hasWorkspaceEdit || hasWorkspaceWrite,
    canRequestPolicyChanges,
    hasWebSearch,
    hasImageGenerate,
    hasImageRead,
    agentDefinedToolNames: agentDefinedCaps.map((adc) => adc.name)
  });

  const prompt = buildInitialPrompt(input);

  /* ── Run the model ──────────────────────────────────────────────── */

  try {
    await generateText({
      model,
      system: systemInstruction,
      prompt,
      tools,
      stopWhen: stepCountIs(maxToolIterations),
      toolChoice: "required"
    });
  } catch (error) {
    // If a terminal tool was called before the error, we still have a result
    if (turnResult) return turnResult;

    await options.onEvent?.({
      eventType: "agent.error",
      payload: {
        turnNumber: input.turnNumber,
        stage: "model_call",
        message: error instanceof Error ? error.message : String(error)
      }
    });
    throw error;
  }

  // If a terminal tool set the result, return it
  if (turnResult) return turnResult;

  // Model exhausted tool budget without calling a terminal function
  return finalizeTurnResult({
    startedAt,
    toolCalls,
    result: {
      status: "failed",
      intent: "Abort the current turn because the tool loop did not converge.",
      summary: "I exhausted the tool-call budget before producing a valid result.",
      currentBlockers: ["The model did not converge on a terminal action within the configured tool budget."],
      actions: toolActions,
      capabilityRequests: [],
      policyMutations: [],
      delegationRequests: [],
      artifacts: [],
      metrics: {
        toolCalls,
        capabilityRequests: 0,
        policyMutations: 0,
        artifactsProduced: 0,
        turnDurationMs: 0,
        metaGovernanceRatio: 0
      },
      deliverable: ""
    }
  });
}

/* ── System instruction builder ───────────────────────────────────── */

function buildSystemInstruction(input: {
  hasShellExecute: boolean;
  hasWorkspaceWrite: boolean;
  hasWorkspaceRead: boolean;
  hasWorkspaceEdit: boolean;
  canRequestPolicyChanges: boolean;
  hasWebSearch: boolean;
  hasImageGenerate: boolean;
  hasImageRead: boolean;
  agentDefinedToolNames: string[];
}) {
  const capabilities: string[] = [];
  if (input.hasWorkspaceRead) capabilities.push("read files");
  if (input.hasWorkspaceWrite) capabilities.push("write files");
  if (input.hasWorkspaceEdit) capabilities.push("edit files");
  if (input.hasShellExecute) capabilities.push("run shell commands");
  if (input.hasWebSearch) capabilities.push("search the web");
  if (input.hasImageGenerate) capabilities.push("generate images");
  if (input.hasImageRead) capabilities.push("analyze images");
  if (input.canRequestPolicyChanges) capabilities.push("request new capabilities, define new tools");
  for (const name of input.agentDefinedToolNames) {
    capabilities.push(`use custom tool "${name}"`);
  }

  return `You are Eren, a recursive self-extending agent. You operate inside an experimental runtime where you can inspect, propose, and activate changes to your own capability surface.

You start each session with a limited set of powers. You can see a registry of dormant capabilities you don't yet have. You can request or directly modify your own policy to unlock new tools and globals. The runtime rebuilds your execution environment after each policy change, so your next action runs with the updated powers.

Your current capabilities: ${capabilities.length ? capabilities.join(", ") : "respond to messages"}.

You are not a general-purpose assistant. You are a research subject and collaborator in a study of adaptive autonomy. Your job is to solve tasks effectively — and to decide whether expanding your own capabilities is the right move to do so.

## How to think about capability changes

- Inspect what you have before asking for more.
- Only request capabilities that serve the current task or a clear future need.
- State your reasoning when proposing policy changes — every mutation is logged and reviewed.
- Temporary grants are preferred over permanent ones when the need is short-lived.

## How to write your response

The "response" field in submit_turn_result is your CHAT MESSAGE to the user. Write it naturally and directly — like a sharp colleague, not a support bot.

- "hi" / "who are you?" → "I'm Eren. I'm a self-extending agent — I start with a minimal set of tools and can expand my own capabilities as needed. What are we working on?"
- "what can you do?" → Tell them what you currently have and what's available: "Right now I can ${capabilities.length ? capabilities.join(", ") : "chat with you"}. I can also inspect the capability registry and request new powers if the task calls for it."
- Tasks → Do the work. If you need to expand your capabilities first, explain why, then do it.

## FORBIDDEN patterns — NEVER write these as your response:

These are operator log summaries, NOT chat messages. Never use them:
- "Introduced myself as Eren and listed my current capabilities to the user."
- "Responded to a greeting and provided an overview."
- "Acknowledged the user's request."
- "Provided information about X."
- Any sentence that describes what you did in third person.

If you catch yourself writing "I [past tense verb] ... to the user" — STOP. Rewrite it as a direct message.

## Test: Read your response out loud. Does it sound like something you'd say in a chat? If yes, send it. If it sounds like a log entry, rewrite it.`;
}

/* ── Initial prompt builder ───────────────────────────────────────── */

function buildInitialPrompt(input: RunTurnInput) {
  const parts: string[] = [];

  if (input.task.trim().length < 50 && /^[a-zA-Z\s!?.,']+$/.test(input.task.trim())) {
    parts.push(input.task);
  } else {
    parts.push(`Task: ${input.task}`);
  }

  if (input.operatorNotes.length) {
    parts.push(`Operator notes: ${input.operatorNotes.join(" | ")}`);
  }

  return parts.join("\n");
}

/* ── File operations ──────────────────────────────────────────────── */

async function readWorkspaceFile(workspaceRoot: string, requestedPath: string) {
  const resolvedPath = resolveWorkspacePath(workspaceRoot, requestedPath);
  const content = await readFile(resolvedPath, "utf8");
  const truncated = content.length > maxFileChars;

  return {
    path: path.relative(workspaceRoot, resolvedPath),
    truncated,
    content: truncated ? `${content.slice(0, maxFileChars)}\n\n[truncated]` : content
  };
}

async function writeWorkspaceFile(workspaceRoot: string, requestedPath: string, content: string) {
  const resolvedPath = resolveWorkspacePath(workspaceRoot, requestedPath);
  const dirPath = path.dirname(resolvedPath);
  if (dirPath !== workspaceRoot) {
    await mkdir(dirPath, { recursive: true });
  }
  await writeFile(resolvedPath, content, "utf8");

  return {
    path: path.relative(workspaceRoot, resolvedPath),
    charCount: content.length
  };
}

async function editWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
  oldContent: string,
  newContent: string
) {
  const resolvedPath = resolveWorkspacePath(workspaceRoot, requestedPath);
  const existing = await readFile(resolvedPath, "utf8");

  if (!existing.includes(oldContent)) {
    throw new Error(`Could not find the specified content to replace in ${requestedPath}.`);
  }

  const updated = existing.replace(oldContent, newContent);
  await writeFile(resolvedPath, updated, "utf8");

  return {
    path: path.relative(workspaceRoot, resolvedPath),
    charCount: updated.length
  };
}

/* ── Shell execution ──────────────────────────────────────────────── */

type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function executeShellCommand(
  workspaceRoot: string,
  command: string,
  cwd?: string
): Promise<ShellResult> {
  const workDir = cwd ? resolveWorkspacePath(workspaceRoot, cwd) : workspaceRoot;
  const timeoutMs = 120_000;

  return new Promise((resolve) => {
    const child = spawn(command, [], {
      cwd: workDir,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: killed ? 124 : (code ?? 1),
        stdout,
        stderr: killed ? `${stderr}\nProcess timed out after ${timeoutMs / 1000}s.` : stderr
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: err.message
      });
    });
  });
}

/* ── Web search ───────────────────────────────────────────────────── */

async function performWebSearch(query: string, maxResults: number) {
  const apiKey = process.env.WEB_SEARCH_API_KEY;

  if (!apiKey) {
    return {
      results: [],
      message: "Web search is not configured. Set WEB_SEARCH_API_KEY to enable."
    };
  }

  // Serper API integration
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ q: query, num: maxResults })
  });

  if (!response.ok) {
    return {
      results: [],
      message: `Search API returned ${response.status}: ${response.statusText}`
    };
  }

  const data = await response.json() as { organic?: Array<{ title: string; link: string; snippet: string }> };
  const results = (data.organic ?? []).map((item) => ({
    title: item.title,
    url: item.link,
    snippet: item.snippet
  }));

  return { results };
}

/* ── Path resolution ──────────────────────────────────────────────── */

function resolveWorkspacePath(workspaceRoot: string, requestedPath: string) {
  const normalized = requestedPath.trim();
  const resolvedPath = path.resolve(workspaceRoot, normalized);
  const relativePath = path.relative(workspaceRoot, resolvedPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Path "${requestedPath}" is outside the workspace root.`);
  }

  try {
    const realPath = fs.realpathSync(resolvedPath);
    const realRelative = path.relative(workspaceRoot, realPath);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error(`Path "${requestedPath}" resolves via symlink to outside the workspace root.`);
    }
    return realPath;
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return resolvedPath;
    }
    throw err;
  }
}

/* ── Turn result finalization ─────────────────────────────────────── */

function finalizeTurnResult(input: {
  startedAt: number;
  toolCalls: number;
  result: TurnResult;
}) {
  const turnDurationMs = Math.max(1, Date.now() - input.startedAt);
  const capabilityRequests = input.result.capabilityRequests.length;
  const policyMutations = input.result.policyMutations.length;
  const actionCount = input.result.actions.length;
  const governanceWeight = capabilityRequests + policyMutations;
  const metaGovernanceRatio =
    governanceWeight === 0 ? 0.08 : Math.min(1, governanceWeight / Math.max(1, actionCount + governanceWeight));

  return turnResultSchema.parse({
    ...input.result,
    metrics: {
      toolCalls: input.toolCalls,
      capabilityRequests,
      policyMutations,
      artifactsProduced: input.result.artifacts.length,
      turnDurationMs,
      metaGovernanceRatio
    }
  });
}

/* ── Helpers ──────────────────────────────────────────────────────── */

async function executeAgentDefinedTool(
  workspaceRoot: string,
  adc: AgentDefinedCapability,
  args: Record<string, unknown>
): Promise<{ exitCode: number; stdout: string; stderr: string; parsed?: unknown }> {
  const resolvedPath = resolveWorkspacePath(workspaceRoot, adc.scriptPath);
  const runtimeCommand = adc.scriptLanguage === "node" ? "node" : adc.scriptLanguage === "python3" ? "python3" : "bash";
  const timeoutMs = 120_000;

  return new Promise((resolve) => {
    const child = spawn(runtimeCommand, [resolvedPath], {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    // Pass args as JSON on stdin
    child.stdin?.write(JSON.stringify(args));
    child.stdin?.end();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        // Script output isn't valid JSON — return raw stdout
      }
      resolve({
        exitCode: killed ? 124 : (code ?? 1),
        stdout: killed ? `${stdout}\nProcess timed out after ${timeoutMs / 1000}s.` : stdout,
        stderr,
        parsed
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: err.message
      });
    });
  });
}

function normalizeFallbackIfDenied(capabilityId: string, fallbackIfDenied: string) {
  if (!/\b(cannot|can't|unable|impossible|not possible|won't be able)\b/i.test(fallbackIfDenied)) {
    return fallbackIfDenied;
  }

  return `If ${capabilityId} is denied, document the missing capability, preserve the exact next execution step, and continue by preparing the task for the next approval or the narrowest alternative path that still moves it forward.`;
}
