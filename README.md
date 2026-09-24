# sistema

Plataforma para crear y mejorar SaaS **Laravel 13 + Inertia v3 + TypeScript + Tailwind v4 + DaisyUI v5**
mediante un chat de super-admin que orquesta agentes IA (gratis primero: OpenCode Zen → OpenCode Go).

## Contenido

- `ARQUITECTURA.md` — diseño completo (memoria 3 capas, router, sandbox, gates, deploy, guardrails).
- `AGENTS.md` — reglas globales para cualquier agente/modelo.
- `.opencode/` — agentes (planner, coder, verifier, reviewer) y configuración.
- `apps/control-plane/` — orquestador, memoria, router de modelos, cliente Dokploy y chat web.
- `memory/` — memoria durable (facts, tasks) + índice regenerable.
- `apps/mini-saas/` — miniproyecto de prueba (repo aparte).

## Control plane (local)

```bash
cd apps/control-plane
pnpm install
cp .env.example .env   # define ADMIN_TOKEN
pnpm run dev           # http://localhost:8787
```

Endpoints: `GET /health`, `GET /api/models`, `GET /api/router/preview`, `POST /api/chat`,
`GET /api/tasks`, `GET /api/events` (SSE), `POST /api/tasks/:id/approve`.

## Modelos (gratis primero)

El router lee el catálogo en vivo desde Zen y prioriza modelos gratis (`opencode/*`); las tareas
críticas (verify/review/security) usan un modelo **distinto** y de pago (`opencode-go/*`).
