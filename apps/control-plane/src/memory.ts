import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db, now } from "./db.js";

/**
 * Memoria en 3 capas (ver ARQUITECTURA.md §4):
 *  - CAPA 1 LEDGER     : memory/facts/*.md        (hechos durables, versionados)
 *  - CAPA 2 BEADS      : tabla tasks + memory/tasks/<id>.md (estado por tarea)
 *  - CAPA 3 EXECUTION  : tabla events             (efímero/compactable)
 */

const memoryRoot = path.join(config.repoRoot, "memory");
export const factsDir = path.join(memoryRoot, "facts");
export const tasksDir = path.join(memoryRoot, "tasks");
export const indexDir = path.join(memoryRoot, "index");

for (const dir of [memoryRoot, factsDir, tasksDir, indexDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// ---------- CAPA 1: LEDGER (facts) ----------

export type Fact = { slug: string; title: string; content: string };

export function listFacts(): Fact[] {
  return fs
    .readdirSync(factsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const content = fs.readFileSync(path.join(factsDir, f), "utf8");
      const title = content.match(/^#\s+(.+)$/m)?.[1] ?? f.replace(/\.md$/, "");
      return { slug: f.replace(/\.md$/, ""), title, content };
    });
}

export function writeFact(name: string, title: string, body: string): Fact {
  const s = slug(name);
  const content = `# ${title}\n\n_Actualizado: ${new Date().toISOString()}_\n\n${body}\n`;
  fs.writeFileSync(path.join(factsDir, `${s}.md`), content, "utf8");
  return { slug: s, title, content };
}

export function searchFacts(query: string, limit = 5): Fact[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  const scored = listFacts().map((f) => {
    const hay = (f.title + " " + f.content).toLowerCase();
    const score = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
    return { f, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.f);
}

// ---------- CAPA 2: BEADS (task markdown) ----------

export function taskMdPath(id: string): string {
  return path.join(tasksDir, `${slug(id)}.md`);
}

export function readTaskMd(id: string): string {
  const p = taskMdPath(id);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

export function writeTaskMd(id: string, content: string): void {
  fs.writeFileSync(taskMdPath(id), content, "utf8");
}

function upsertSection(content: string, section: string, body: string): string {
  const header = `## ${section}`;
  const re = new RegExp(`## ${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?(?=\\n## |$)`);
  const block = `${header}\n\n${body.trim()}\n`;
  if (re.test(content)) return content.replace(re, block);
  return `${content.trimEnd()}\n\n${block}`;
}

export function upsertTaskSection(id: string, section: string, body: string): void {
  const current =
    readTaskMd(id) || `# Tarea ${id}\n\n_Creada: ${new Date().toISOString()}_\n`;
  writeTaskMd(id, upsertSection(current, section, body));
}

// ---------- CAPA 3: EXECUTION (events) ----------

export function logEvent(taskId: string | null, type: string, data: unknown): void {
  db.prepare(`INSERT INTO events (task_id, ts, type, data) VALUES (?, ?, ?, ?)`).run(
    taskId,
    now(),
    type,
    JSON.stringify(data ?? {}),
  );
}

export function taskEvents(taskId: string, limit = 200): Array<{ ts: number; type: string; data: unknown }> {
  const rows = db
    .prepare(`SELECT ts, type, data FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?`)
    .all(taskId, limit) as Array<{ ts: number; type: string; data: string }>;
  return rows.reverse().map((r) => ({ ts: r.ts, type: r.type, data: JSON.parse(r.data) }));
}

// ---------- ÍNDICE DE CÓDIGO (evitar releer archivos) ----------

const SKIP = new Set(["node_modules", "vendor", ".git", "dist", "build", ".next", "storage", "public/build", ".pnpm-store"]);
const TEXT_EXT = new Set([
  ".php", ".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".json", ".md", ".blade.php", ".css", ".sql", ".yml", ".yaml",
]);

function summarizeFile(rel: string, content: string): { summary: string; symbols: string } {
  const lines = content.split(/\r?\n/);
  const doc = lines.find((l) => /\/\/|\/\*|\*|#/.test(l) && l.trim().length > 3)?.replace(/^[\s/*#]+/, "").slice(0, 160) ?? "";
  const symbols = Array.from(
    content.matchAll(
      /\b(?:export\s+)?(?:abstract\s+)?(?:class|function|def|interface|type|enum|const|public function|protected function|private function|function)\s+([A-Za-z_][\w]*)/g,
    ),
  )
    .map((m) => m[1])
    .slice(0, 12)
    .join(", ");
  const summary = `${rel}${symbols ? ` — símbolos: ${symbols}` : ""}${doc ? `. ${doc}` : ""}`;
  return { summary, symbols };
}

export function indexRepo(repo: string, root: string): number {
  const upsert = db.prepare(`
    INSERT INTO code_index (repo, path, summary, symbols, updated)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repo, path) DO UPDATE SET summary=excluded.summary, symbols=excluded.symbols, updated=excluded.updated
  `);
  let count = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const ext = path.extname(entry.name);
      if (!TEXT_EXT.has(ext) && !entry.name.endsWith(".blade.php")) continue;
      const stat = fs.statSync(full);
      if (stat.size > 200_000) continue;
      const content = fs.readFileSync(full, "utf8");
      const rel = path.relative(root, full).replace(/\\/g, "/");
      const { summary, symbols } = summarizeFile(rel, content);
      upsert.run(repo, rel, summary, symbols, now());
      count++;
    }
  };
  walk(root);
  return count;
}

export function searchCode(repo: string, query: string, limit = 15): Array<{ path: string; summary: string }> {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (terms.length === 0) return [];
  const where = terms.map(() => `(lower(path) LIKE ? OR lower(summary) LIKE ? OR lower(symbols) LIKE ?)`).join(" OR ");
  const params: string[] = [repo];
  for (const t of terms) {
    const like = `%${t}%`;
    params.push(like, like, like);
  }
  const rows = db.prepare(`SELECT path, summary FROM code_index WHERE repo = ? AND (${where}) LIMIT ?`).all(...params, limit) as Array<{ path: string; summary: string }>;
  return rows;
}

// ---------- Bundle de contexto para el agente ----------

export function buildContextBundle(taskId: string, query: string, repo = "main"): string {
  const facts = searchFacts(query, 5);
  const code = searchCode(repo, query, 12);
  const task = readTaskMd(taskId);
  return [
    `# Contexto rehidratado (task ${taskId})`,
    ``,
    `## Reglas globales`,
    `Leer y respetar AGENTS.md. Stack: Laravel 13 + Inertia v3 + TS + Tailwind v4 + DaisyUI v5.`,
    ``,
    `## Estado de la tarea`,
    task || "(sin estado previo)",
    ``,
    `## Hechos relevantes`,
    facts.length ? facts.map((f) => `- ${f.title}: ${f.content.split("\n").slice(2).join(" ").slice(0, 200)}`).join("\n") : "(ninguno)",
    ``,
    `## Índice de código relevante (NO releer archivos completos)`,
    code.length ? code.map((c) => `- ${c.summary}`).join("\n") : "(sin coincidencias en el índice)",
  ].join("\n");
}
