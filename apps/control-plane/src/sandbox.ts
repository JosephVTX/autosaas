import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { logEvent } from "./memory.js";

export type RunResult = { code: number; stdout: string; stderr: string };

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export type Sandbox = {
  id: string;
  mode: "none" | "docker";
  dir: string;
  containerId?: string;
  cleanup: () => Promise<void>;
};

const sandboxesRoot = path.join(config.dataDir, "sandboxes");

export async function createSandbox(taskId: string, repoUrl?: string, branch?: string): Promise<Sandbox> {
  fs.mkdirSync(sandboxesRoot, { recursive: true });
  const id = taskId.replace(/[^a-zA-Z0-9-]/g, "_");
  const dir = path.join(sandboxesRoot, id);
  fs.mkdirSync(dir, { recursive: true });

  const cleanup = async (): Promise<void> => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  };

  if (config.sandboxMode === "docker") {
    const res = await run("docker", [
      "run", "-d", "--rm",
      "--network", "none",
      "--cpus", "1", "--memory", "1g",
      "-w", "/workspace",
      config.sandboxImage,
      "sleep", "infinity",
    ]);
    const containerId = res.stdout.trim();
    logEvent(taskId, "sandbox.created", { mode: "docker", containerId });
    return {
      id,
      mode: "docker",
      dir,
      containerId,
      cleanup: async () => {
        if (containerId) await run("docker", ["rm", "-f", containerId]);
        await cleanup();
      },
    };
  }

  // modo local (sin docker): clonar el repo si se provee, si no, workspace vacío
  if (repoUrl) {
    const token = config.githubToken ? `https://x-access-token:${config.githubToken}@` : "";
    const url = repoUrl.replace(/^https:\/\//, token);
    const clone = await run("git", ["clone", "--depth", "1", url, "."], { cwd: dir });
    if (clone.code !== 0) logEvent(taskId, "sandbox.clone.failed", { stderr: clone.stderr.slice(0, 500) });
    if (branch) await run("git", ["checkout", "-b", branch], { cwd: dir });
  }
  logEvent(taskId, "sandbox.created", { mode: "none", dir });
  return { id, mode: "none", dir, cleanup };
}

export async function runInSandbox(sb: Sandbox, cmd: string, args: string[]): Promise<RunResult> {
  if (sb.mode === "docker" && sb.containerId) {
    return run("docker", ["exec", "-w", "/workspace", sb.containerId, cmd, ...args]);
  }
  return run(cmd, args, { cwd: sb.dir });
}
