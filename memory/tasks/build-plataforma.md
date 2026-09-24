# Tarea build-plataforma

_Creada: 2026-09-24_

## Pedido

Crear toda la arquitectura del SaaS auto-mejorable (control-plane, memoria, router gratis→go, sandbox,
deploy Dokploy) + un miniproyecto Laravel 13 + Inertia v3 + TS + Tailwind v4 + DaisyUI v5 + Boost, y
desplegarlo en Dokploy.

## Resultado

- **Repo plataforma**: `github.com/JosephVTX/autosaas` (público).
- **Repo miniproyecto**: `github.com/JosephVTX/mini-saas` (público).
- **Control-plane**: `https://control-plane.129.146.63.224.sslip.io` (port 8787, Dockerfile en `apps/control-plane`).
- **Mini-saas**: `https://mini-saas.129.146.63.224.sslip.io` (port 8000, FrankenPHP + Postgres 18 en Dokploy).
- Dokploy: proyecto `autosaas` (`EXrQCO_rYwtjyh9vnja-C`), environment `production` (`ot5T3PAcp_okBuE8ASSi_`).

## Componentes del control-plane (Node 24 + TS, sin deps de runtime, `node:sqlite`)

- `src/memory.ts` — memoria 3 capas (facts/tasks/index) + bundle de contexto.
- `src/router.ts` — catálogo Zen en vivo, selección gratis→go por clase de tarea, `callModel`.
- `src/orchestrator.ts` — máquina de estados + pipeline (plan→implement→verify→review→approval→deploy).
- `src/sandbox.ts` — sandbox efímero (docker o local) + runner de comandos.
- `src/agent.ts` — ejecuta etapas (opencode headless o simulación/modelo).
- `src/dokploy.ts` — cliente de la API de Dokploy.
- `src/server.ts` + `public/index.html` — chat super-admin + SSE.

## Gates (todos en verde)

- Control-plane: `tsc --noEmit` + `tsc` build; smoke test local y en prod (health, models, router, chat).
- Mini-saas: Pint ✅, PHPStan ✅, vue-tsc ✅, Pest 4 (40/40) ✅, Vite build ✅.
- Deploy: ambos apps `done` y HTTP 200.

## Aprendizajes / gotchas resueltos

- Dokploy `sourceType=git` requiere repo público o credenciales → repos públicos para el test.
- `application.saveBuildType`/`saveGitProvider`/`saveEnvironment` exigen campos extra en esta versión.
- Wayfinder (plugin de Vite) necesita PHP en el build → builder unificado PHP+Node.
- La imagen base de FrankenPHP trae HEALTHCHECK contra el admin de Caddy → se sobreescribió.
- Postgres en Dokploy requiere `postgres.deploy` además de `postgres.create`.

## Próximos pasos sugeridos

- Activar `AGENT_MODE=opencode` y `SANDBOX_MODE=docker` para ejecución real del agente.
- Secretos en Dokploy (no en el repo). Rotar `ADMIN_TOKEN`/tokens tras el test.
- Añadir preview envs + Playwright (Fase 5) y canary/rollback con Pennant (Fase 6).
