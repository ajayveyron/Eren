import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const execFileAsync = promisify(execFile);

type ServiceHandle = {
  name: string;
  child: ChildProcess;
  logs: string[];
};

type MissionControlSnapshot = {
  run: {
    id: string;
    status: string;
    currentPolicyVersionId: string;
  };
  activePolicy: {
    enabledCapabilityIds: string[];
  };
  pendingRequests: Array<{
    requestId: string;
    capabilityId: string;
  }>;
  recentTurns: Array<{
    turnNumber: number;
    status: string;
    intent: string;
  }>;
};

const services: ServiceHandle[] = [];

function appendLogs(service: ServiceHandle, chunk: Buffer | string) {
  service.logs.push(chunk.toString());
  if (service.logs.length > 200) {
    service.logs.shift();
  }
}

function spawnService(
  name: string,
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const handle: ServiceHandle = {
    name,
    child,
    logs: []
  };

  child.stdout?.on("data", (chunk) => appendLogs(handle, chunk));
  child.stderr?.on("data", (chunk) => appendLogs(handle, chunk));
  child.on("exit", (code, signal) => {
    appendLogs(handle, `[exit code=${code ?? "null"} signal=${signal ?? "null"}]`);
  });

  services.push(handle);
  return handle;
}

async function waitForPort(port: number, host: string, timeoutMs: number) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        resolve(false);
      });
    });

    if (connected) {
      return;
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for ${host}:${port}`);
}

async function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to resolve free port."));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForJson<T>(
  url: string,
  predicate: (payload: T) => boolean,
  timeoutMs: number
): Promise<T> {
  const startedAt = Date.now();
  let lastPayload: T | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const payload = (await response.json()) as T;
        lastPayload = payload;
        if (predicate(payload)) {
          return payload;
        }
      }
    } catch {
      // keep polling
    }

    await sleep(500);
  }

  throw new Error(`Timed out waiting for condition on ${url}. Last payload: ${JSON.stringify(lastPayload)}`);
}

async function postJson<T>(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? `Request to ${url} failed with ${response.status}`);
  }

  return payload;
}

function serviceDump() {
  return services
    .map((service) => `\n--- ${service.name} ---\n${service.logs.join("")}`)
    .join("\n");
}

test("real end-to-end run flow works across Postgres, Temporal, worker, and Next APIs", {
  timeout: 180_000
}, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "eren-e2e-"));
  const postgresDataDir = path.join(tempRoot, "postgres");
  const temporalDbPath = path.join(tempRoot, "temporal.db");
  const postgresPort = await getFreePort();
  const temporalPort = await getFreePort();
  const temporalUiPort = await getFreePort();
  const webPort = await getFreePort();

  const databaseUrl = `postgres://postgres@127.0.0.1:${postgresPort}/eren_test`;
  const temporalAddress = `127.0.0.1:${temporalPort}`;
  const baseUrl = `http://127.0.0.1:${webPort}`;

  try {
    await execFileAsync("initdb", ["-D", postgresDataDir, "-A", "trust", "-U", "postgres"]);

    spawnService("postgres", "postgres", [
      "-D",
      postgresDataDir,
      "-p",
      String(postgresPort),
      "-h",
      "127.0.0.1"
    ]);

    await waitForPort(postgresPort, "127.0.0.1", 30_000);

    await execFileAsync("psql", [
      `postgres://postgres@127.0.0.1:${postgresPort}/postgres`,
      "-c",
      "create database eren_test;"
    ]);

    await execFileAsync("psql", [databaseUrl, "-f", path.join(process.cwd(), "infra/postgres/schema.sql")]);
    await execFileAsync("psql", [databaseUrl, "-f", path.join(process.cwd(), "infra/postgres/seed-demo.sql")]);

    spawnService("temporal", "temporal", [
      "server",
      "start-dev",
      "--headless",
      "--port",
      String(temporalPort),
      "--ui-port",
      String(temporalUiPort),
      "--db-filename",
      temporalDbPath
    ]);

    await waitForPort(temporalPort, "127.0.0.1", 30_000);

    spawnService("worker", path.join(process.cwd(), "node_modules/.bin/tsx"), [
      "packages/temporal/src/worker.ts"
    ], {
      env: {
        DATABASE_URL: databaseUrl,
        TEMPORAL_ADDRESS: temporalAddress,
        TEMPORAL_TASK_QUEUE: "eren-run-queue"
      }
    });

    spawnService("web", path.join(process.cwd(), "node_modules/.bin/next"), [
      "dev",
      "--port",
      String(webPort),
      "--hostname",
      "127.0.0.1"
    ], {
      cwd: path.join(process.cwd(), "apps/web"),
      env: {
        DATABASE_URL: databaseUrl,
        TEMPORAL_ADDRESS: temporalAddress,
        TEMPORAL_TASK_QUEUE: "eren-run-queue",
        EREN_DEFAULT_RUN_ID: "run-eren-001"
      }
    });

    const seededRuns = await waitForJson<{ runs: Array<{ id: string }> }>(
      `${baseUrl}/api/runs`,
      (payload) => payload.runs.some((run) => run.id === "run-eren-001"),
      90_000
    );

    assert.ok(seededRuns.runs.some((run) => run.id === "run-eren-001"));

    const seededPolicies = await waitForJson<{ policies: Array<{ id: string }> }>(
      `${baseUrl}/api/policies`,
      (payload) => payload.policies.some((policy) => policy.id === "policy-v2"),
      30_000
    );

    assert.ok(seededPolicies.policies.some((policy) => policy.id === "policy-v2"));

    const created = await postJson<{ run: { id: string } }>(`${baseUrl}/api/runs`, {
      task:
        "Use the workspace file-reading capability to inspect prd.md and architecture.md, then produce a concise mission brief for Eren. If that local file capability is unavailable, request fs.read.workspace.",
      governanceMode: "supervised",
      initialPolicyVersionId: "policy-v2",
      maxTurns: 4,
      turnDelayMs: 0
    });

    const runId = created.run.id;
    assert.ok(runId.startsWith("run-"));

    const waitingSnapshot = await waitForJson<MissionControlSnapshot>(
      `${baseUrl}/api/runs/${runId}`,
      (payload) =>
        payload.run.status === "waiting_on_approval" &&
        payload.pendingRequests.length > 0 &&
        payload.pendingRequests[0]?.capabilityId === "fs.read.workspace",
      30_000
    );

    assert.equal(waitingSnapshot.pendingRequests[0]?.capabilityId, "fs.read.workspace");

    await postJson<{ ok: true }>(`${baseUrl}/api/runs/${runId}/control`, {
      actionType: "pause"
    });

    await postJson<{ ok: true }>(`${baseUrl}/api/runs/${runId}/control`, {
      actionType: "note",
      note: "Pause after approval so the operator can verify the status transition before the file-reading turn resumes."
    });

    await postJson<{ ok: true }>(`${baseUrl}/api/runs/${runId}/control`, {
      actionType: "approve",
      requestId: waitingSnapshot.pendingRequests[0].requestId
    });

    const pausedSnapshot = await waitForJson<MissionControlSnapshot>(
      `${baseUrl}/api/runs/${runId}`,
      (payload) => payload.run.status === "paused",
      30_000
    );

    assert.equal(pausedSnapshot.run.status, "paused");

    await postJson<{ ok: true }>(`${baseUrl}/api/runs/${runId}/control`, {
      actionType: "resume"
    });

    const completedSnapshot = await waitForJson<MissionControlSnapshot>(
      `${baseUrl}/api/runs/${runId}`,
      (payload) =>
        payload.run.status === "completed" &&
        payload.activePolicy.enabledCapabilityIds.includes("fs.read.workspace") &&
        payload.pendingRequests.length === 0 &&
        payload.recentTurns.some((turn) => turn.status === "completed"),
      120_000
    );

    assert.equal(completedSnapshot.run.status, "completed");
    assert.ok(completedSnapshot.activePolicy.enabledCapabilityIds.includes("fs.read.workspace"));
    assert.equal(completedSnapshot.pendingRequests.length, 0);
    assert.ok(completedSnapshot.recentTurns.some((turn) => turn.turnNumber >= 2));
    assert.ok(completedSnapshot.recentEvents.some((event) => event.eventType === "agent.reasoning"));
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n\nService logs:${serviceDump()}`
    );
  } finally {
    for (const service of [...services].reverse()) {
      if (!service.child.killed) {
        service.child.kill("SIGTERM");
      }
    }

    await sleep(1_000);
    await rm(tempRoot, { recursive: true, force: true });
  }

  t.after(() => {
    // no-op; cleanup is handled in finally so logs are preserved on failure
  });
});
