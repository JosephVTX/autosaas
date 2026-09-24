import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { bus, createTask, getTask, listTasks, approveTask, runPipeline } from "./orchestrator.js";
import { catalog, chooseModel } from "./router.js";
import { listFacts, writeFact, taskEvents } from "./memory.js";
import { dokploy, dokployConfigured } from "./dokploy.js";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function authorized(req: http.IncomingMessage, url: URL): boolean {
  const header = req.headers["x-admin-token"];
  const auth = req.headers["authorization"];
  const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const token = (typeof header === "string" ? header : "") || bearer || url.searchParams.get("token") || "";
  return token.length > 0 && token === config.adminToken;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { message: raw };
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(res: http.ServerResponse, rel: string): void {
  const safe = rel.replace(/\.\./g, "");
  const file = path.join(publicDir, safe === "/" || safe === "" ? "index.html" : safe);
  if (!file.startsWith(publicDir) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;

    try {
      if (p === "/health") return json(res, 200, { status: "ok", uptime: process.uptime() });

      if (p === "/api/models") {
        const models = await catalog();
        return json(res, 200, { order: config.modelOrder, models });
      }

      // Todo lo demás bajo /api requiere auth
      if (p.startsWith("/api/")) {
        if (!authorized(req, url)) return json(res, 401, { error: "no autorizado" });

        if (p === "/api/chat" && req.method === "POST") {
          const body = await readBody(req);
          const message = String(body.message ?? "").trim();
          if (!message) return json(res, 400, { error: "message requerido" });
          const meta = (body.meta as Record<string, unknown>) ?? {};
          const task = createTask(message, meta);
          void runPipeline(task.id);
          return json(res, 201, { task });
        }

        if (p === "/api/tasks" && req.method === "GET") return json(res, 200, { tasks: listTasks() });

        const taskMatch = p.match(/^\/api\/tasks\/([^/]+)$/);
        if (taskMatch && req.method === "GET") {
          const task = getTask(taskMatch[1]!);
          if (!task) return json(res, 404, { error: "no existe" });
          return json(res, 200, { task, events: taskEvents(task.id) });
        }

        const approveMatch = p.match(/^\/api\/tasks\/([^/]+)\/approve$/);
        if (approveMatch && req.method === "POST") {
          await approveTask(approveMatch[1]!);
          return json(res, 200, { ok: true });
        }

        if (p === "/api/facts" && req.method === "GET") return json(res, 200, { facts: listFacts() });
        if (p === "/api/facts" && req.method === "POST") {
          const body = await readBody(req);
          const fact = writeFact(String(body.name ?? "hecho"), String(body.title ?? "Hecho"), String(body.body ?? ""));
          return json(res, 201, { fact });
        }

        if (p === "/api/router/preview") {
          const classes = ["plan", "code", "verify", "review", "security"] as const;
          const out: Record<string, unknown> = {};
          for (const c of classes) out[c] = await chooseModel(c);
          return json(res, 200, out);
        }

        if (p === "/api/dokploy/health") {
          if (!dokployConfigured()) return json(res, 200, { configured: false });
          const r = await dokploy.health();
          return json(res, 200, { configured: true, ok: r.ok, data: r.data });
        }

        if (p === "/api/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write(`: connected\n\n`);
          const onEvent = (e: unknown): void => {
            res.write(`data: ${JSON.stringify(e)}\n\n`);
          };
          bus.on("event", onEvent);
          const ping = setInterval(() => res.write(`: ping\n\n`), 15000);
          req.on("close", () => {
            clearInterval(ping);
            bus.off("event", onEvent);
          });
          return;
        }

        return json(res, 404, { error: "ruta no encontrada" });
      }

      // UI estática
      if (req.method === "GET") return serveStatic(res, p);
      res.writeHead(405);
      res.end();
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });
}
