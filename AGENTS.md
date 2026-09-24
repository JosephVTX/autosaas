# Reglas del proyecto (self-improving SaaS platform)

## Principios

- **Nunca editar producción.** Todo cambio pasa por Git en una rama; prod solo cambia por deploy aprobado.
- **La memoria vive fuera del modelo** (ver `memory/`). Antes de actuar, rehidratar contexto; al terminar, escribir resumen.
- **No leer archivos completos.** Ubicar con índice/LSP/grep y abrir solo el fragmento exacto (`Read offset/limit`).
- **Eficiencia primero:** menos tokens, menos I/O, menos re-análisis.

## Stack objetivo de los proyectos gestionados

- Laravel 13 (PHP 8.3+), Inertia v3 + TypeScript, Tailwind CSS v4, DaisyUI v5.
- Contexto IA con **Laravel Boost** (`laravel/boost`): MCP + guidelines version-aware + docs API.

## Gestión de paquetes

- Node/JS: **pnpm** (nunca npm/yarn).
- PHP: composer (proyectos Laravel).

## Modelos (gratis primero)

- Orden: `opencode/*` (Zen, gratis) → `opencode-go/*` (pago) → otros.
- Plan/resúmenes: modelo barato. Implementación: gratis fuerte → Go si falla. Review: modelo **distinto** al de implementación. Seguridad/migraciones: Go.

## Definición de terminado (DoD)

1. Lint + tipos + build en verde (Pint/PHPStan/tsc/Vite).
2. Tests (Pest) en verde.
3. Sin secretos en el diff.
4. Cambio detrás de feature flag (Pennant) cuando aplique.
5. Resumen escrito en `memory/tasks/<task-id>.md`.

## Prohibido

- Tocar `config/`, `.env`, auth, billing, infra o secretos sin aprobación explícita.
- `git push --force` a `main`.
- Ejecutar migraciones contra la BD de producción.
- Commitear credenciales, tokens o `.env`.
