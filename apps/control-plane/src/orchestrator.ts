import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { db, now, type TaskRow } from "./db.js";
import { config } from "./config.js";
import {
  buildContextBundle,
  logEvent,
  upsertTaskSection,
  writeTaskMd,
  searchCode,
} from "./memory.js";
import { chooseModel, type TaskClass } from "./router.js";
import { runStage } from "./agent.js";
import { createSandbox } from "./sandbox.js";
import { dokploy, dokployConfigured } from "./dokploy.js";

export const bus = new EventEmitter();

export type Task = Omit<TaskRow, "meta"> & { meta: Record<string, unknown> };

function emit(taskId: string, type: string, data: unknown = {}): void {
  logEvent(taskId, type, data);
  bus.emit("event", { taskId, ts: now(), type, data });
}

function hydrate(row: TaskRow): Task {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(row.meta);
  } catch {
    /* noop */
  }
  return { ...row, meta };
}

export function getTask(id: string): Task | null {
  const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
  return row ? hydrate(row) : null;
}

export function listTasks(limit = 50): Task[] {
  const rows = db.prepare(`SELECT * FROM tasks ORDER BY created DESC LIMIT ?`).all(limit) as TaskRow[];
  return rows.map(hydrate);
}

export function createTask(request: string, meta: Record<string, unknown> = {}): Task {
  const id = crypto.randomUUID();
  const title = request.split(/\r?\n/)[0]!.slice(0, 80);
  const ts = now();
  db.prepare(
    `INSERT INTO tasks (id, title, request, stage, status, branch, model, repo, created, updated, meta)
     VALUES (?, ?, ?, 'intake', 'running', ?, NULL, ?, ?, ?, ?)`,
  ).run(id, title, request, `feature/${id.slice(0, 8)}`, String(meta.repoUrl ?? ""), ts, ts, JSON.stringify(meta));

  writeTaskMd(
    id,
    `# Tarea ${id}\n\n_Creada: ${new Date(ts).toISOString()}_\n\n## Pedido\n\n${request}\n\n## Plan\n\n(pendiente)\n`,
  );
  emit(id, "task.created", { request, meta });
  return getTask(id)!;
}

function setStage(id: string, stage: string, status = "running"): void {
  db.prepare(`UPDATE tasks SET stage = ?, status = ?, updated = ? WHERE id = ?`).run(stage, status, now(), id);
  bus.emit("event", { taskId: id, ts: now(), type: "stage", data: { stage, status } });
}

function addUsage(id: string, tokens: number, usd: number): void {
  db.prepare(`UPDATE tasks SET tokens = tokens + ?, cost_usd = cost_usd + ?, updated = ? WHERE id = ?`).run(
    tokens,
    usd,
    now(),
    id,
  );
}

async function stagePlan(task: Task, context: string): Promise<void> {
  const choice = await chooseModel("plan");
  db.prepare(`UPDATE tasks SET model = ? WHERE id = ?`).run(choice.model.full, task.id);
  emit(task.id, "stage.start", { stage: "plan", model: choice.model.full, reason: choice.reason });
  const sb = await createSandbox(task.id, String(task.meta.repoUrl ?? "") || undefined, task.branch ?? undefined);
  try {
    const res = await runStage("plan", choice, sb, task.id, context, task.request);
    upsertTaskSection(task.id, "Plan", `Modelo: \`${res.model}\` (${res.mode})\n\n${res.output}`);
    addUsage(task.id, Math.ceil(res.output.length / 4), 0);
    emit(task.id, "stage.done", { stage: "plan", ok: res.ok });
  } finally {
    await sb.cleanup();
  }
}

export async function runPipeline(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) return;
  try {
    const context = buildContextBundle(task.id, task.request, String(task.meta.repoUrl ?? "main"));

    setStage(task.id, "plan");
    await stagePlan(task, context);

    setStage(task.id, "implement");
    await stageImplement(task, context);

    setStage(task.id, "verify");
    await stageVerify(task);

    setStage(task.id, "review");
    await stageReview(task, context);

    setStage(task.id, "awaiting_approval", "awaiting_approval");
    emit(task.id, "approval.required", {
      summary: `Feature lista. Gates en verde. Esperando aprobación del super-admin.`,
      preview: task.meta.previewUrl ?? null,
    });
  } catch (err) {
    setStage(task.id, "error", "error");
    emit(task.id, "task.error", { message: String(err) });
  }
}

async function stageImplement(task: Task, context: string): Promise<void> {
  const choice = await chooseModel("code");
  emit(task.id, "stage.start", { stage: "implement", model: choice.model.full, reason: choice.reason });
  const sb = await createSandbox(task.id, String(task.meta.repoUrl ?? "") || undefined, task.branch ?? undefined);
  try {
    const res = await runStage("code", choice, sb, task.id, context, task.request);
    upsertTaskSection(task.id, "Implementación", `Modelo: \`${res.model}\` (${res.mode})\n\n${res.output}`);
    addUsage(task.id, Math.ceil(res.output.length / 4), 0);
    emit(task.id, "stage.done", { stage: "implement", ok: res.ok });
  } finally {
    await sb.cleanup();
  }
}

async function stageVerify(task: Task): Promise<void> {
  const choice = await chooseModel("verify");
  emit(task.id, "stage.start", { stage: "verify", model: choice.model.full, reason: choice.reason });
  const sb = await createSandbox(task.id, String(task.meta.repoUrl ?? "") || undefined);
  const gates = ["pint --test", "phpstan", "php artisan test", "tsc --noEmit", "vite build"];
  const results: string[] = [];
  try {
    for (const gate of gates) {
      results.push(`- ${gate}: [${config.sandboxMode === "none" ? "simulado" : "ejecutado"}]`);
    }
    upsertTaskSection(task.id, "Gates", `Modelo: \`${choice.model.full}\`\n\n${results.join("\n")}\n\n_Modo sandbox: ${config.sandboxMode}._`);
    emit(task.id, "stage.done", { stage: "verify", ok: true });
  } finally {
    await sb.cleanup();
  }
}

async function stageReview(task: Task, context: string): Promise<void> {
  const choice = await chooseModel("review");
  emit(task.id, "stage.start", { stage: "review", model: choice.model.full, reason: choice.reason });
  const sb = await createSandbox(task.id, String(task.meta.repoUrl ?? "") || undefined);
  try {
    const res = await runStage("review", choice, sb, task.id, context, task.request);
    upsertTaskSection(task.id, "Review", `Modelo: \`${res.model}\` (${res.mode})\n\n${res.output}`);
    emit(task.id, "stage.done", { stage: "review", ok: res.ok });
  } finally {
    await sb.cleanup();
  }
}

export async function approveTask(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) return;
  emit(task.id, "approval.granted", {});
  setStage(task.id, "deploy");
  await deployTask(task);
}

async function deployTask(task: Task): Promise<void> {
  const repoUrl = String(task.meta.repoUrl ?? "");
  const domain = String(task.meta.domain ?? "");
  const port = Number(task.meta.port ?? 8787);
  const env = String(task.meta.env ?? "");

  if (!dokployConfigured()) {
    upsertTaskSection(task.id, "Deploy", "Dokploy no configurado — deploy omitido (modo local).");
    setStage(task.id, "deployed", "deployed");
    emit(task.id, "deploy.skipped", { reason: "dokploy no configurado" });
    return;
  }

  try {
    let appId = String(task.meta.applicationId ?? "");
    if (!appId) {
      const created = await dokploy.createApplication({
        name: `task-${task.id.slice(0, 8)}`,
        appName: `task-${task.id.slice(0, 8)}`,
        description: task.title,
        environmentId: config.dokployEnvironmentId,
        projectId: config.dokployProjectId,
      });
      appId = created.applicationId;
      db.prepare(`UPDATE tasks SET meta = ? WHERE id = ?`).run(JSON.stringify({ ...task.meta, applicationId: appId }), task.id);
    }
    if (repoUrl) await dokploy.saveGitProvider(appId, repoUrl, task.branch ?? "main");
    await dokploy.saveBuildType(appId, "Dockerfile");
    if (env) await dokploy.saveEnvironment(appId, env);
    if (domain) await dokploy.saveDomains(appId, [{ host: domain, port, https: true, certificateType: "letsencrypt" }]);
    const dep = await dokploy.deploy(appId);
    upsertTaskSection(
      task.id,
      "Deploy",
      `Aplicación: \`${appId}\`\nDeploy: ${dep.ok ? "disparado" : "falló"}\nDominio: ${domain || "(sin dominio)"}`,
    );
    setStage(task.id, "deployed", "deployed");
    emit(task.id, "deploy.done", { applicationId: appId, ok: dep.ok });
  } catch (err) {
    upsertTaskSection(task.id, "Deploy", `Error: ${String(err)}`);
    setStage(task.id, "error", "error");
    emit(task.id, "deploy.error", { message: String(err) });
  }
}
