import { config } from "./config.js";

/**
 * Model Router: gratis primero (`opencode/*` Zen) → pago (`opencode-go/*`).
 * El catálogo Zen se lee en caliente; no se hardcodea la disponibilidad.
 */

export type Model = {
  id: string; // id sin proveedor
  full: string; // provider/id listo para opencode
  provider: string;
  free: boolean;
};

const ZEN = "opencode";
const GO = "opencode-go";

// Orden de preferencia para implementación (si están disponibles)
const CODE_PREF = ["big-pickle", "mimo-v2.5-free", "nemotron-3-ultra-free", "ling-3.0-flash-fin-free"];
const FAST_PREF = ["nemotron-3.5-lightning-free", "ling-3.0-flash-fin-free", "nemotron-3-ultra-free"];
const GO_MODELS = ["deepseek-v4.1-flash"];

let cache: { at: number; models: Model[] } | null = null;
const TTL = 60 * 60 * 1000;

export async function catalog(): Promise<Model[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.models;
  const models: Model[] = [];
  try {
    const res = await fetch(config.zenModelsUrl, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      for (const m of body.data ?? []) {
        const free = /free|big-pickle|pickle/i.test(m.id);
        models.push({ id: m.id, full: `${ZEN}/${m.id}`, provider: ZEN, free });
      }
    }
  } catch {
    // offline → usamos fallback
  }
  if (models.length === 0) {
    for (const id of [...CODE_PREF, ...FAST_PREF]) {
      models.push({ id, full: `${ZEN}/${id}`, provider: ZEN, free: true });
    }
  }
  for (const id of GO_MODELS) {
    models.push({ id, full: `${GO}/${id}`, provider: GO, free: false });
  }
  cache = { at: Date.now(), models };
  return models;
}

function pick(ids: string[], models: Model[]): Model | undefined {
  for (const id of ids) {
    const hit = models.find((m) => m.id === id);
    if (hit) return hit;
  }
  return undefined;
}

export type TaskClass = "plan" | "summary" | "code" | "verify" | "review" | "security";
export type Choice = { model: Model; reason: string };

export async function chooseModel(taskClass: TaskClass): Promise<Choice> {
  const models = await catalog();
  const preferFree = config.modelOrder.indexOf(ZEN) <= config.modelOrder.indexOf(GO);

  const freePicked =
    taskClass === "plan" || taskClass === "summary"
      ? pick(FAST_PREF, models) ?? models.find((m) => m.free)
      : pick(CODE_PREF, models) ?? models.find((m) => m.free);

  const goModel = models.find((m) => m.provider === GO && GO_MODELS.includes(m.id)) ?? models.find((m) => !m.free);

  // Tareas críticas → modelo fuerte (Go) y distinto al de implementación
  if (taskClass === "verify" || taskClass === "review" || taskClass === "security") {
    if (goModel) return { model: goModel, reason: `${taskClass}: modelo pago/distinto (evita puntos ciegos)` };
    if (freePicked) return { model: freePicked, reason: `${taskClass}: sin Go disponible, gratis fuerte` };
  }

  if (preferFree && freePicked) {
    return { model: freePicked, reason: `${taskClass}: modelo gratis Zen preferido` };
  }
  const fallback = freePicked ?? goModel;
  if (!fallback) throw new Error("No hay modelos disponibles");
  return { model: fallback, reason: `${taskClass}: fallback` };
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Llama a un modelo Zen (OpenAI-compatible). Devuelve null si no hay API key o falla. */
export async function callModel(model: Model, messages: ChatMessage[], maxTokens = 1500): Promise<string | null> {
  if (!config.zenApiKey || model.provider !== ZEN) return null;
  try {
    const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.zenApiKey}`,
      },
      body: JSON.stringify({ model: model.id, messages, max_tokens: maxTokens, temperature: 0.2 }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}
