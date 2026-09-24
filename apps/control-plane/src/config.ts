import fs from "node:fs";
import path from "node:path";

function bool(v: string | undefined, def = false): boolean {
  if (v === undefined) return def;
  return v === "1" || v.toLowerCase() === "true";
}

const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 8787),
  dataDir,
  repoRoot: process.env.SYSTEM_REPO_ROOT ?? process.cwd(),

  adminToken: process.env.ADMIN_TOKEN ?? "change-me",

  // Model router
  modelOrder: (process.env.MODEL_ORDER ?? "opencode,opencode-go")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  zenModelsUrl: process.env.ZEN_MODELS_URL ?? "https://opencode.ai/zen/v1/models",
  zenApiKey: process.env.ZEN_API_KEY ?? "",
  maxTokensPerTask: Number(process.env.MAX_TOKENS_PER_TASK ?? 200000),
  budgetUsdDaily: Number(process.env.BUDGET_USD_DAILY ?? 5),

  // Agent
  agentMode: process.env.AGENT_MODE ?? "simulate", // simulate | opencode
  opencodeBin: process.env.OPENCODE_BIN ?? "opencode",

  // Sandbox
  sandboxMode: process.env.SANDBOX_MODE ?? "none", // none | docker
  sandboxImage: process.env.SANDBOX_IMAGE ?? "ghcr.io/sistema/sandbox:latest",

  // Dokploy
  dokployUrl: process.env.DOKPLOY_URL ?? "",
  dokployApiKey: process.env.DOKPLOY_API_KEY ?? "",
  dokployProjectId: process.env.DOKPLOY_PROJECT_ID ?? "",
  dokployEnvironmentId: process.env.DOKPLOY_ENVIRONMENT_ID ?? "",

  // GitHub
  githubToken: process.env.GITHUB_TOKEN ?? "",

  dryRun: bool(process.env.DRY_RUN, false),
} as const;

export type Config = typeof config;
