import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createRunWorkflowActivities } from "./activities";

loadEnvFromRepoRoot();

async function run() {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233"
  });

  const worker = await Worker.create({
    connection,
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "eren-run-queue",
    activities: createRunWorkflowActivities(),
    workflowsPath: fileURLToPath(new URL("./workflows/run-workflow.ts", import.meta.url))
  });

  await worker.run();
}

run().catch((error) => {
  console.error("Temporal worker failed to start", error);
  process.exit(1);
});

function loadEnvFromRepoRoot() {
  const explicitEnvPath = process.env.EREN_ENV_PATH;
  const repoRootEnvPath = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)), ".env");
  const candidatePaths = [
    explicitEnvPath,
    repoRootEnvPath,
    path.resolve(process.cwd(), ".env")
  ].filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);

  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) {
      continue;
    }

    process.loadEnvFile?.(candidatePath);
    break;
  }
}
