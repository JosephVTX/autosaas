# Stack objetivo

_Actualizado: 2026-09-24_

Los proyectos gestionados usan:

- **Laravel 13** (PHP 8.3+), **Inertia v3**, **TypeScript**, **Tailwind CSS v4**, **DaisyUI v5**.
- Testing con **Pest 4**, estilo con **Pint**, análisis estático con **Larastan/PHPStan**.
- **Laravel Boost** (`laravel/boost`) para contexto IA: MCP + guidelines version-aware + docs API.
- Flags con **Laravel Pennant**. Colas con Redis/Horizon. BD PostgreSQL (pgvector para semántica).

Reglas clave:

- Node/JS con **pnpm** (nunca npm/yarn).
- Deploy a **Dokploy** vía Git + Dockerfile, con canary y rollback.
- Nunca editar producción: todo pasa por Git y aprobación humana.
