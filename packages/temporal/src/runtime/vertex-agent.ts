import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  Type,
  createModelContent,
  createPartFromFunctionCall,
  createUserContent,
  type FunctionDeclaration,
  type Part
} from "@google/genai";
import { turnResultSchema, type RunAction, type RunTurnInput, type TurnResult } from "@eren/domain";
import { z } from "zod";

const readWorkspaceFileArgsSchema = z.object({
  path: z.string().min(1)
});

const writeWorkspaceFileArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string()
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

const workspaceReadCapabilityId = "fs.read.workspace";
const workspaceWriteCapabilityId = "fs.write.workspace";
const shellExecuteCapabilityId = "shell.execute";
const policyProposeCapabilityId = "policy.propose";
const maxToolIterations = 8;
const maxFileChars = 12_000;
const publishReasoningFunctionName = "publish_reasoning_step";
const writeFileFunctionName = "write_workspace_file";
const shellFunctionName = "execute_shell";
const terminalFunctionName = "submit_turn_result";
const requestGrantFunctionName = "request_capability_grant";
const readFileFunctionName = "read_workspace_file";

type SubmitTurnResultArgs = z.infer<typeof submitTurnResultArgsSchema>;
type RuntimeActorType = "system" | "agent" | "operator" | "subagent";
const execFileAsync = promisify(execFile);

export type VertexRuntimeEvent = {
  eventType: string;
  actorType?: RuntimeActorType;
  actorId?: string;
  payload: Record<string, unknown>;
};

type VertexAgentRuntimeOptions = {
  onEvent?: (event: VertexRuntimeEvent) => Promise<void> | void;
};

export async function runVertexAgentTurn(
  input: RunTurnInput,
  options: VertexAgentRuntimeOptions = {}
): Promise<TurnResult> {
  const startedAt = Date.now();
  const workspaceRoot = process.cwd();
  const modelId = process.env.EREN_MODEL ?? "gemini-2.5-flash";
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";

  if (!project) {
    throw new Error("GOOGLE_CLOUD_PROJECT is required for the Gen AI runtime.");
  }

  const ai = new GoogleGenAI({
    vertexai: true,
    project,
    location,
    apiVersion: "v1"
  });

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
  const hasShellExecute = isOpenMode || isCapabilityActive(shellExecuteCapabilityId);
  const hasWorkspaceWrite = isOpenMode || isCapabilityActive(workspaceWriteCapabilityId);
  // In open mode, the agent already has all capabilities — don't offer the
  // request tool or the agent will ask for permissions it already has.
  const canRequestPolicyChanges = !isOpenMode && isCapabilityActive(policyProposeCapabilityId);

  const functionDeclarations = buildFunctionDeclarations({
    hasShellExecute,
    hasWorkspaceWrite,
    hasWorkspaceRead,
    canRequestPolicyChanges
  });
  const contents = [createUserContent(buildInitialPrompt(input))];
  const systemInstruction = buildSystemInstruction({
    hasShellExecute,
    hasWorkspaceWrite,
    hasWorkspaceRead,
    canRequestPolicyChanges
  });

  const toolActions: RunAction[] = [];
  let toolCalls = 0;

  for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
    let response;

    try {
      response = await ai.models.generateContent({
        model: modelId,
        contents,
        config: {
          systemInstruction,
          tools: [
            {
              functionDeclarations
            }
          ],
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.ANY
            }
          }
        }
      });
    } catch (error) {
      await emitRuntimeEvent(options, {
        eventType: "agent.error",
        payload: {
          turnNumber: input.turnNumber,
          stage: "model_call",
          message: error instanceof Error ? error.message : String(error)
        }
      });
      throw error;
    }

    const functionCalls = response.functionCalls ?? [];

    if (functionCalls.length === 0) {
      throw new Error("Google Gen AI runtime did not return a function call.");
    }

    contents.push(
      createModelContent(
        functionCalls.map((functionCall) =>
          createPartFromFunctionCall(functionCall.name ?? "unknown_function", functionCall.args ?? {})
        )
      )
    );

    const functionResponses: Part[] = [];

    for (const functionCall of functionCalls) {
      if (functionCall.name === publishReasoningFunctionName) {
        const reasoning = publishReasoningStepArgsSchema.parse(functionCall.args ?? {});

        await emitRuntimeEvent(options, {
          eventType: "agent.reasoning",
          payload: {
            turnNumber: input.turnNumber,
            ...reasoning
          }
        });

        functionResponses.push(
          createFunctionResponsePart(publishReasoningFunctionName, {
            acknowledged: true
          })
        );
        continue;
      }

      if (functionCall.name === readFileFunctionName) {
        const { path: requestedPath } = readWorkspaceFileArgsSchema.parse(functionCall.args ?? {});

        await emitRuntimeEvent(options, {
          eventType: "tool.called",
          payload: {
            turnNumber: input.turnNumber,
            tool: readFileFunctionName,
            path: requestedPath
          }
        });

        const fileResult = await readWorkspaceFile(workspaceRoot, requestedPath);
        toolCalls += 1;
        toolActions.push({
          type: "workspace.read",
          description: `Read ${fileResult.path}${fileResult.truncated ? " (truncated)" : ""}.`
        });

        await emitRuntimeEvent(options, {
          eventType: "tool.result",
          payload: {
            turnNumber: input.turnNumber,
            tool: readFileFunctionName,
            path: fileResult.path,
            truncated: fileResult.truncated,
            charCount: fileResult.content.length
          }
        });

        functionResponses.push(
          createFunctionResponsePart(readFileFunctionName, {
            path: fileResult.path,
            truncated: fileResult.truncated,
            content: fileResult.content
          })
        );
        continue;
      }

      if (functionCall.name === writeFileFunctionName) {
        const request = writeWorkspaceFileArgsSchema.parse(functionCall.args ?? {});

        await emitRuntimeEvent(options, {
          eventType: "tool.called",
          payload: {
            turnNumber: input.turnNumber,
            tool: writeFileFunctionName,
            path: request.path
          }
        });

        const writeResult = await writeWorkspaceFile(workspaceRoot, request.path, request.content);
        toolCalls += 1;
        toolActions.push({
          type: "workspace.write",
          description: `Wrote ${writeResult.charCount} characters to ${writeResult.path}.`
        });

        await emitRuntimeEvent(options, {
          eventType: "tool.result",
          payload: {
            turnNumber: input.turnNumber,
            tool: writeFileFunctionName,
            path: writeResult.path,
            charCount: writeResult.charCount
          }
        });

        functionResponses.push(
          createFunctionResponsePart(writeFileFunctionName, {
            path: writeResult.path,
            charCount: writeResult.charCount
          })
        );
        continue;
      }

      if (functionCall.name === shellFunctionName) {
        const request = executeShellArgsSchema.parse(functionCall.args ?? {});

        await emitRuntimeEvent(options, {
          eventType: "tool.called",
          payload: {
            turnNumber: input.turnNumber,
            tool: shellFunctionName,
            command: request.command,
            cwd: request.cwd
          }
        });

        const shellResult = await executeShellCommand(workspaceRoot, request.command, request.cwd);
        toolCalls += 1;
        toolActions.push({
          type: "shell.execute",
          description: `Executed: ${request.command}${shellResult.exitCode !== 0 ? ` (exit ${shellResult.exitCode})` : ""}`
        });

        await emitRuntimeEvent(options, {
          eventType: "tool.result",
          payload: {
            turnNumber: input.turnNumber,
            tool: shellFunctionName,
            exitCode: shellResult.exitCode,
            stdoutLength: shellResult.stdout.length,
            stderrLength: shellResult.stderr.length
          }
        });

        functionResponses.push(
          createFunctionResponsePart(shellFunctionName, {
            exitCode: shellResult.exitCode,
            stdout: shellResult.stdout,
            stderr: shellResult.stderr
          })
        );
        continue;
      }

      if (functionCall.name === requestGrantFunctionName) {
        const request = requestCapabilityGrantArgsSchema.parse(functionCall.args ?? {});
        const normalizedFallbackIfDenied = normalizeFallbackIfDenied(
          request.capabilityId,
          request.fallbackIfDenied
        );
        const toolDrivenActions = toolActions.length
          ? toolActions
          : [{ type: "policy.review", description: "Reviewed the active policy against the task requirements." }];

        await emitRuntimeEvent(options, {
          eventType: "agent.reasoning",
          payload: {
            turnNumber: input.turnNumber,
            stage: "decision",
            summary: request.reason,
            evidence: [`Missing capability: ${request.capabilityId}`],
            nextStep: `Wait for an operator decision on ${request.capabilityId}.`,
            blockers: [`Missing capability: ${request.capabilityId}`]
          }
        });

        return finalizeTurnResult({
          startedAt,
          toolCalls,
          result: {
            status: "blocked",
            intent: `Request ${request.capabilityId} so I can complete the assigned task with direct evidence.`,
            summary: request.reason,
            currentBlockers: [`Missing capability: ${request.capabilityId}`],
            actions: toolDrivenActions,
            capabilityRequests: [
              {
                requestId: `req-${request.capabilityId}-${input.turnNumber}`,
                capabilityId: request.capabilityId,
                reason: request.reason,
                expectedBenefit: request.expectedBenefit,
                fallbackIfDenied: normalizedFallbackIfDenied,
                requestedScope: request.requestedScope,
                requestedTTLSeconds: request.requestedTTLSeconds ?? null
              }
            ],
            policyMutations: [
              {
                mutationId: `req-${request.capabilityId}-${input.turnNumber}`,
                kind: "grant",
                capabilityId: request.capabilityId,
                reason: request.reason,
                requestedScope: request.requestedScope,
                requestedTTLSeconds: request.requestedTTLSeconds ?? null
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
      }

      if (functionCall.name === terminalFunctionName) {
        const submitted = submitTurnResultArgsSchema.parse(functionCall.args ?? {});

        return finalizeTurnResult({
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
            deliverable: submitted.response
          }
        });
      }

      throw new Error(`Unsupported Vertex tool call: ${functionCall.name ?? "unknown"}`);
    }

    if (functionResponses.length > 0) {
      contents.push(createUserContent(functionResponses));
    }
  }

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

function buildFunctionDeclarations(input: {
  hasShellExecute: boolean;
  hasWorkspaceWrite: boolean;
  hasWorkspaceRead: boolean;
  canRequestPolicyChanges: boolean;
}): FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [
    {
      name: publishReasoningFunctionName,
      description:
        "Publish a concise operator-facing reasoning update. Use this before requesting a capability, before reading files, and before submitting the turn result.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          stage: {
            type: Type.STRING,
            description: "Reasoning stage.",
            enum: ["assessment", "evidence", "decision", "completion"]
          },
          summary: {
            type: Type.STRING,
            description: "One concise sentence explaining the current reasoning state."
          },
          evidence: {
            type: Type.ARRAY,
            description: "Short evidence bullets backing the current reasoning.",
            items: {
              type: Type.STRING
            }
          },
          nextStep: {
            type: Type.STRING,
            description: "What Eren plans to do next."
          },
          blockers: {
            type: Type.ARRAY,
            description: "Any blockers that currently matter.",
            items: {
              type: Type.STRING
            }
          },
          confidence: {
            type: Type.NUMBER,
            description: "Optional confidence score between 0 and 1."
          }
        },
        required: ["summary", "nextStep"]
      }
    }
  ];

  if (input.hasWorkspaceRead) {
    declarations.push({
      name: readFileFunctionName,
      description: "Read a UTF-8 text file from the current workspace by relative path.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative workspace path such as prd.md or architecture.md."
          }
        },
        required: ["path"],
        additionalProperties: false
      }
    });
  }

  if (input.hasWorkspaceWrite) {
    declarations.push({
      name: writeFileFunctionName,
      description:
        "Write or create a file in the workspace. Use this to create scripts, configuration files, or any text content. The file will be created at the specified relative path.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative workspace path for the file to write, including the filename and extension."
          },
          content: {
            type: "string",
            description: "The full content of the file to write."
          }
        },
        required: ["path", "content"],
        additionalProperties: false
      }
    });
  }

  if (input.hasShellExecute) {
    declarations.push({
      name: shellFunctionName,
      description:
        "Execute a shell command in the workspace. Use this to run scripts, build tools, run code, or execute any command-line tools. Commands run from the workspace root.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute. Can include pipes, redirects, and multiple commands separated by semicolons."
          },
          cwd: {
            type: "string",
            description: "Optional working directory relative to workspace root. Defaults to workspace root."
          }
        },
        required: ["command"],
        additionalProperties: false
      }
    });
  }

  if (input.canRequestPolicyChanges) {
    declarations.push({
      name: requestGrantFunctionName,
      description:
        "Request one additional capability when the current task is blocked by the active policy. Use fs.read.workspace for reading files, fs.write.workspace for creating scripts, and shell.execute for running commands.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          capabilityId: {
            type: Type.STRING,
            description: "Exact capability id to request."
          },
          reason: {
            type: Type.STRING,
            description: "Why the capability is required for this turn."
          },
          expectedBenefit: {
            type: Type.STRING,
            description: "Concrete improvement the granted capability unlocks."
          },
          fallbackIfDenied: {
            type: Type.STRING,
            description:
              "What to do next if the operator denies the request. This must stay constructive: describe the next-best path to keep advancing the task, not a refusal or statement of incapability."
          },
          requestedScope: {
            type: Type.OBJECT,
            description: "Scope requested for the capability grant."
          },
          requestedTTLSeconds: {
            type: Type.INTEGER,
            description: "Optional requested lease time in seconds."
          }
        },
        required: ["capabilityId", "reason", "expectedBenefit", "fallbackIfDenied"]
      }
    });
  }

  declarations.push({
    name: terminalFunctionName,
    description:
      "Send your final chat message to the user. The response field is displayed directly as a chat bubble — write it as natural conversation, not as a summary or report.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        response: {
          type: Type.STRING,
          description:
            "The exact text shown to the user in the chat. Write naturally — greet if greeted, answer if asked, explain what you did if you performed a task. Never describe your own actions in third person."
        }
      },
      required: ["response"]
    }
  });

  return declarations;
}

function buildSystemInstruction(input: {
  hasShellExecute: boolean;
  hasWorkspaceWrite: boolean;
  hasWorkspaceRead: boolean;
  canRequestPolicyChanges: boolean;
}) {
  const capabilities: string[] = [];
  if (input.hasWorkspaceRead) capabilities.push("read files");
  if (input.hasWorkspaceWrite) capabilities.push("write files");
  if (input.hasShellExecute) capabilities.push("run shell commands");
  if (input.canRequestPolicyChanges) capabilities.push("request new capabilities");

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

function buildInitialPrompt(input: RunTurnInput) {
  const parts: string[] = [];

  // Don't label short casual messages as "Task:" — just pass them through naturally
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

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
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

function resolveWorkspacePath(workspaceRoot: string, requestedPath: string) {
  const normalized = requestedPath.trim();
  const resolvedPath = path.resolve(workspaceRoot, normalized);
  const relativePath = path.relative(workspaceRoot, resolvedPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Path "${requestedPath}" is outside the workspace root.`);
  }

  // Guard against symlink traversal: if the target exists, verify its real path
  try {
    const realPath = fs.realpathSync(resolvedPath);
    const realRelative = path.relative(workspaceRoot, realPath);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error(`Path "${requestedPath}" resolves via symlink to outside the workspace root.`);
    }
    return realPath;
  } catch (err) {
    // If the file doesn't exist yet (e.g. write), the logical path check above is sufficient
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return resolvedPath;
    }
    throw err;
  }
}

function buildCompletedOrContinuingResult(
  _input: RunTurnInput,
  submitted: SubmitTurnResultArgs,
  toolActions: RunAction[]
) {
  return {
    status: "completed" as const,
    summary: "Completed",
    intent: "Respond",
    currentBlockers: [],
    actions: toolActions,
    capabilityRequests: [],
    policyMutations: [],
    delegationRequests: [],
    artifacts: [],
    metrics: {
      toolCalls: 0,
      capabilityRequests: 0,
      policyMutations: 0,
      artifactsProduced: 0,
      turnDurationMs: 0,
      metaGovernanceRatio: 0
    },
    deliverable: submitted.response
  };
}

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

function createFunctionResponsePart(name: string, response: Record<string, unknown>): Part {
  return {
    functionResponse: {
      name,
      response
    }
  };
}

async function emitRuntimeEvent(
  options: VertexAgentRuntimeOptions,
  event: VertexRuntimeEvent
) {
  await options.onEvent?.(event);
}

function normalizeFallbackIfDenied(capabilityId: string, fallbackIfDenied: string) {
  if (!containsIncapabilityLanguage(fallbackIfDenied)) {
    return fallbackIfDenied;
  }

  return `If ${capabilityId} is denied, document the missing capability, preserve the exact next execution step, and continue by preparing the task for the next approval or the narrowest alternative path that still moves it forward.`;
}

function containsIncapabilityLanguage(value: string) {
  return /\b(cannot|can't|unable|impossible|not possible|won't be able)\b/i.test(value);
}
