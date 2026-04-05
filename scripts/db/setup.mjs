import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

loadEnvFromRepoRoot();

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Add it to the repo root .env or export it in your shell.");
  process.exit(1);
}

const schemaPath = path.join(repoRoot, "infra/postgres/schema.sql");
const seedPath = path.join(repoRoot, "infra/postgres/seed-demo.sql");

const schemaSql = readFileSync(schemaPath, "utf8");
const seedSql = readFileSync(seedPath, "utf8");

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

try {
  await client.connect();
  await client.query(schemaSql);
  await client.query(seedSql);
  console.log(`Database bootstrapped successfully.`);
  console.log(`Schema: ${schemaPath}`);
  console.log(`Seed: ${seedPath}`);
} finally {
  await client.end().catch(() => {});
}

function loadEnvFromRepoRoot() {
  const explicitEnvPath = process.env.EREN_ENV_PATH;
  const repoRootEnvPath = path.join(repoRoot, ".env");
  const candidatePaths = [
    explicitEnvPath,
    repoRootEnvPath,
    path.resolve(process.cwd(), ".env")
  ].filter((value, index, array) => Boolean(value) && array.indexOf(value) === index);

  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) {
      continue;
    }

    process.loadEnvFile?.(candidatePath);
    break;
  }
}
