import { config } from "./config.js";
import { callModel, type ChatMessage } from "./router.js";
import { runInSandbox, type Sandbox } from "./sandbox.js";
import type { Choice, TaskClass } from "./router.js";

export type StageResult = {
  stage: TaskClass;
  model: string;
  mode: "opencode" | "simulate" | "model";
  output: string;
  ok: boolean;
};

const AGENT_FOR_STAGE: Record<TaskClass, string> = {
  plan: "planner",
  summary: "planner",
  code: "coder",
  verify: "verifier",
  review: "reviewer",
  security: "reviewer",
};

const SYSTEM_BY_STAGE: Record<TaskClass, string> = {
  plan: "Eres el Planner. Produce objetivo, criterios de aceptación, checklist y archivos afectados. Breve y accionable.",
  summary: "Resume el estado de la tarea en 5 viñetas.",
  code: "Eres el Coder. Devuelve el plan de implementación y los archivos a crear/editar (no inventes APIs).",
  verify: "Eres el Verifier. Lista los gates a correr y su criterio de éxito.",
  review: "Eres el Reviewer. Revisa el diff buscando secretos, regresiones y malas prácticas.",
  security: "Eres el Reviewer enfocado en seguridad, migraciones y datos.",
};

/**
 * Ejecuta una etapa del pipeline.
 * - modo `opencode`: lanza el CLI headless dentro del sandbox (agente real).
 * - modo `simulate`: usa el modelo vía API si hay key; si no, produce un artefacto determinista.
 */
export async function runStage(
  stage: TaskClass,
  choice: Choice,
  sandbox: Sandbox,
  taskId: string,
  context: string,
  userRequest: string,
): Promise<StageResult> {
  const prompt = `${SYSTEM_BY_STAGE[stage]}\n\n--- CONTEXTO ---\n${context}\n\n--- PETICIÓN ---\n${userRequest}`;

  if (config.agentMode === "opencode") {
    const res = await runInSandbox(sandbox, config.opencodeBin, [
      "run",
      "--model",
      choice.model.full,
      "--agent",
      AGENT_FOR_STAGE[stage],
      prompt,
    ]);
    return {
      stage,
      model: choice.model.full,
      mode: "opencode",
      output: (res.stdout || res.stderr).slice(0, 8000),
      ok: res.code === 0,
    };
  }

  // simulate: intenta el modelo real (gratis) si hay API key
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_BY_STAGE[stage] },
    { role: "user", content: `${context}\n\n--- PETICIÓN ---\n${userRequest}` },
  ];
  const text = await callModel(choice.model, messages);
  if (text) {
    return { stage, model: choice.model.full, mode: "model", output: text.slice(0, 8000), ok: true };
  }

  const simulated = `[simulado] Etapa ${stage} usando ${choice.model.full} (${choice.reason}).\n` +
    `Objetivo: ${userRequest.slice(0, 200)}\n` +
    `Siguiente: ${stage === "plan" ? "implementar en rama feature/" + taskId : "continuar pipeline"}.`;
  return { stage, model: choice.model.full, mode: "simulate", output: simulated, ok: true };
}
