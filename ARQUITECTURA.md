# Arquitectura: Plataforma SaaS auto-mejorable con IA (fail-safe)

> Objetivo: desde cualquier dispositivo, un super-admin conversa con un agente que **crea, modifica,
> testea, valida y despliega** features sobre proyectos **Laravel 13 + Inertia v3 (TypeScript) +
> Tailwind v4 + DaisyUI v5**, usando **OpenCode Zen (modelos gratis primero) y OpenCode Go (pago)**,
> **sin perder contexto** entre modelos, sesiones o límites, con el **menor consumo de recursos** posible.

---

## 0. Principios rectores

1. **El agente nunca edita producción.** Todo cambio pasa por Git. Prod solo cambia por deploy aprobado.
2. **La memoria vive fuera del modelo.** El contexto es un artefacto persistente (archivos + DB), no la
   sesión del LLM. Cambiar de modelo/sesión solo rehidrata ese artefacto → cero pérdida.
3. **Compuerta humana obligatoria para producción.** La aprobación se valida en el control plane, no en el prompt.
4. **Defensa en profundidad.** Cada capa asume que la anterior puede fallar. "A prueba de errores" = muchas
   barreras independientes, no una sola perfecta.
5. **Todo es reversible.** Commit revertible + imagen previa + feature flag + backup.
6. **Eficiencia primero.** Indexar > leer. Recuperar > re-analizar. Efímero > persistente. Cache > repetir.

---

## 1. Visión general

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          CONTROL PLANE (contenedor persistente)                │
│                                                                                │
│  Chat super-admin  ─┐                                                          │
│  (Web/PWA/móvil)    │   ┌──────────────┐   ┌───────────────┐   ┌────────────┐ │
│  Telegram/Slack ────┼──▶│  Orquestador │──▶│  Model Router │──▶│  Memoria   │ │
│                     │   │  (jobs/cola) │   │ free→go→paid  │   │ (Git+SQLite)│ │
│                     │   └──────┬───────┘   └───────┬───────┘   └────────────┘ │
│                     │          │ spawn             │ rehidrata contexto       │
└─────────────────────┼──────────┼───────────────────┼──────────────────────────┘
                      │          │                   │
          ┌───────────┼──────────▼───────────────────┼───────────────┐
          │           │   SANDBOX EFÍMERO (1 por tarea, se destruye) │
          │           │   Docker: PHP 8.3+ / Node / pnpm / Composer  │
          │           │   + Laravel Boost MCP + agente OpenCode       │
          │           └──────────┬───────────────────┬───────────────┘
          │                      │ commit           │ artefactos
          ▼                      ▼                  ▼
   ┌──────────────────────────────────────────────────────────┐
   │                    GIT (fuente de verdad)                 │
   │   rama main  ◀── rama feature/<task-id>  (PR + CI)        │
   └───────────────────────────┬──────────────────────────────┘
                               │ CI verde + APROBACIÓN HUMANA
                               ▼
              ┌───────────────────────────────────────┐
              │  Dokploy → PROD (canary → health → ✅/rollback) │
              └───────────────────────────────────────┘
```

---

## 2. Topología de contenedores

| # | Componente | Persistente | Contiene código del proyecto | Acceso a prod |
|---|-----------|-------------|------------------------------|---------------|
| 1 | **SaaS PROD** (Dokploy) | sí | imagen desplegada | — |
| 2 | **Control Plane** | sí | no (solo habla con Git/CI/Dokploy) | API Dokploy |
| 3 | **Git** (no es contenedor) | sí | **sí, es la fuente de verdad** | — |
| 4 | **Sandbox** (1 por tarea) | efímero, se borra | sí (clon) | **no** |
| 5 | **Preview Env** (1 por tarea) | efímero | sí (build de la rama) | no |

Reglas:

- El sandbox **no monta secretos** ni tiene ruta de red hacia la DB de prod (egress allowlist).
- El control plane sobrevive si el SaaS cae (por eso está separado).
- Concurrencia: N tareas = N sandboxes en paralelo, sin pisarse (ramas + worktrees).

---

## 3. Repositorio (layout propuesto)

```
sistema/
├─ apps/
│  └─ control-plane/            # Orquestador + chat + router + memoria
│     └─ src/
│        ├─ orchestrator/       # máquina de estados de tareas
│        ├─ router/             # selección de modelo (zen free → go)
│        ├─ memory/             # rehidratación + writeback de contexto
│        ├─ sandbox/            # creación/destrucción de contenedores
│        ├─ deploy/             # integración Dokploy + canary/rollback
│        └─ chat/               # API del chat (auth super-admin)
├─ templates/
│  └─ laravel-saas/             # esqueleto Laravel 13 + Inertia v3 + TW4 + DaisyUI5
├─ .opencode/                   # config del agente (agents, skills, plugins, permisos)
├─ .ai/                         # Laravel Boost: guidelines + rules
│  ├─ guidelines/
│  └─ rules/
├─ memory/                      # MEMORIA DURABLE (git-tracked)
│  ├─ facts/                    # hechos verificados (ADR-style)
│  ├─ tasks/                    # estado por tarea (sobrevive sesiones)
│  └─ index/                    # índice de código (FTS/embeddings) — regenerable
└─ AGENTS.md                    # reglas globales para cualquier agente/modelo
```

`.mcp.json`, `CLAUDE.md`, `AGENTS.md` generados por Boost se regeneran con `boost:install` → van a
`.gitignore`, **excepto** el `AGENTS.md` global propio, que se versiona.

---

## 4. Sistema de memoria y contexto (el corazón del sistema)

El requisito "la IA nunca pierde contexto aunque cambie modelo/sesión/límite" se resuelve con
**memoria en tres capas** + **rehidratación determinista**. El contexto NO vive en el modelo.

```
┌──────────────────────────────────────────────────────────────┐
│ CAPA 1 — LEDGER (hechos durables)         → sobrevive siempre │
│   memory/facts/*.md  ·  .ai/rules/  ·  ADRs                   │
│   "Usamos Pennant para flags", "DB = PostgreSQL+pgvector"     │
│   Cambios requieren aprobación humana                         │
├──────────────────────────────────────────────────────────────┤
│ CAPA 2 — BEADS (estado de tarea)          → sobrevive sesiones│
│   memory/tasks/<task-id>.md + tabla en DB                     │
│   plan, checklist, decisiones, qué falta, blockers            │
├──────────────────────────────────────────────────────────────┤
│ CAPA 3 — EXECUTION (contexto de sesión)   → efímero/compacta  │
│   sesión de OpenCode, outputs de tools, buffer de edición     │
│   se resume al cerrar y se escribe en CAPA 2                  │
└──────────────────────────────────────────────────────────────┘
```

### 4.1 Ciclo de vida de una tarea (rehidratación sin pérdida)

**Al iniciar cualquier etapa (o al cambiar de modelo/sesión):**

1. Cargar `AGENTS.md` global + `.ai/rules/` (reglas del proyecto).
2. Llamar a **Laravel Boost MCP** → guidelines + `search-docs` (contexto framework exacto).
3. Cargar `memory/tasks/<task-id>.md` (estado exacto: qué se hizo y qué falta).
4. Recuperar solo los **hechos relevantes** de CAPA 1 por búsqueda semántica (no volcar todo).
5. Recuperar resúmenes de archivos relevantes desde el **índice** (§4.2), no leer archivos completos.

**Al cerrar cualquier etapa:**

- El agente escribe: resumen, decisiones nuevas, archivos tocados, tests, próximo paso, blockers.
- Los hechos nuevos van a CAPA 1; el progreso va a CAPA 2.

Así, un modelo distinto en una sesión nueva arranca con **el mismo estado exacto**. Cero pérdida.

### 4.2 Índice de código (evitar releer archivos)

- Job que, tras cada merge, construye un índice `memory/index/`:
  - **Resúmenes por archivo** (1–3 líneas: propósito, clases/funciones, dependencias).
  - **Búsqueda full-text (SQLite FTS5)** para lookup barato y sin embeddings.
  - **Embeddings opcionales** (Laravel AI SDK + pgvector) solo si el FTS no alcanza.
- El agente **consulta el índice** para ubicar y abre con `Read offset/limit` solo el fragmento exacto.
- Reutiliza el **LSP** (go-to-def, references) para no re-leer. Nunca `cat` de archivos enteros.
- El índice es **regenerable y desechable** → no contamina Git.

### 4.3 Integración con Laravel Boost

- `composer require laravel/boost --dev` + `php artisan boost:install` en cada proyecto.
- MCP server: `php artisan boost:mcp` (registrado en `.mcp.json` del sandbox).
- Herramientas en el sandbox: Application Info, Database Schema/Query, Search Docs, Read Log Entries,
  Last Error, Browser Logs, List Routes/Commands, Tinker, Record Rule.
- **Reglas durables**: el agente usa *Record Rule* para escribir en `.ai/rules` → futuras sesiones heredan.
- Guidelines version-aware (Inertia, Tailwind 4.x, Pest, Pennant, Pint) → código idiomático sin alucinar APIs.
- Docs API con 17.000+ entradas vectorizadas → el agente consulta la versión exacta instalada.

---

## 5. Model Router (gratis primero → Go pago)

```
tarea entrante
   │
   ├─ ¿modelo gratis Zen disponible y suficiente?  ──▶ opencode/<free-model>
   │
   ├─ ¿se agotó rate-limit/límite? ──▶ rehidratar contexto ──▶ opencode-go/<modelo-pago>
   │
   └─ ¿tarea crítica (seguridad/migración)? ──▶ modelo fuerte (Go) + verifier con OTRO modelo
```

Reglas:

- **Orden de proveedores**: `opencode/*` (Zen, gratis) → `opencode-go/*` (pago) → otros. Leer el catálogo
  desde `https://opencode.ai/zen/v1/models` (cambia con el tiempo; **no hardcodear**).
- **Ruteo por clase de tarea** (barato para tareas simples, fuerte para críticas):

  | Etapa | Modelo típico |
  |---|---|
  | Plan / resúmenes / títulos | gratis (flash) |
  | Implementación | gratis fuerte → Go si falla |
  | Verificación / Review | **otro modelo distinto** al de implementación |
  | Seguridad / migraciones | Go (pago) obligatorio |

- **Fallback sin pérdida**: al cambiar de modelo se rehidrata desde CAPA 1+2 → indiferente al proveedor.
- **Control de coste**: tope de tokens por tarea, presupuesto diario, retry con backoff, health-check de modelos.
- La configuración del router vive en `apps/control-plane/src/router/` y es **data-driven**, no código.

---

## 6. Sandbox de ejecución

- **Imagen base** (cacheada, multi-stage): PHP 8.3/8.4 + Composer + Node LTS + pnpm + Chromium (Playwright).
- Al arrancar una tarea: clona repo, `git checkout -b feature/<task-id>`, `composer install`, `pnpm install`.
- Corre **Laravel Boost MCP** dentro → el agente inspecciona la app real.
- **Aislamiento**: sin secretos, egress allowlist (packagist, npm, APIs de modelos), límites CPU/mem/disk.
- **Reutilización**: capas Docker warm + caché de Composer/pnpm → arranque rápido, bajo consumo.
- Al terminar: push de la rama y **destrucción del contenedor**.

---

## 7. Pipeline de agentes

```
INTAKE ─▶ PLAN ─▶ IMPLEMENT ─▶ VERIFY ─▶ REVIEW ─▶ APROBACIÓN ─▶ DEPLOY ─▶ AUDIT
  │        │         │            │          │          │            │        │
  │        │         │            └ loop hasta verde    │            └ canary │
  │        │         └ escribe código + tests           └ humano          rollback
  │        └ spec + checklist + criterios de aceptación
  └ NL → tarea estructurada, escribe CAPA 2
```

- **Planner**: convierte lenguaje natural en spec + lista de tareas + criterios de aceptación.
- **Coder**: implementa en la rama; usa Boost/índice; escribe tests junto al código.
- **Verifier**: corre lint/tipos/build/tests; si falla, vuelve a Coder (loop acotado).
- **Reviewer**: un **modelo distinto** revisa el diff (regresiones, secretos, malas prácticas).
- Cada etapa escribe su resultado en CAPA 2 → reanudable y auditable.

---

## 8. Compuertas de validación (automático, antes de la aprobación)

**Backend (Laravel 13)**

- `vendor/bin/pint --test` (estilo) · `phpstan`/`larastan` max (tipos) · `composer audit` (CVEs).
- `php artisan test` (Pest) con cobertura mínima.
- `php artisan migrate --pretend` + **dry-run sobre copia de esquema** (nunca sobre prod).
- `php artisan route:list`, `config:cache`, `view:cache` (validar que prod compila).

**Frontend (Inertia v3 + TS + TW4 + DaisyUI5)**

- `npx tsc --noEmit` · `pnpm run build` (Vite) · `pnpm run lint` + `prettier --check`.

**Integración / E2E**

- **Preview Env**: build de la rama desplegado en URL efímera.
- **Playwright** (o Laravel Dusk) contra el preview: smoke + flujos de la feature.
- Health checks + revisión de `storage/logs` y errores del browser.

**Regla**: si **cualquier** gate falla → no hay aprobación posible. La rama queda bloqueada para merge.

---

## 9. Compuerta humana + deploy (Dokploy) + feature flags

1. El agente presenta al super-admin (en el chat): resumen del diff, gates ✅, URL de preview, riesgo,
   plan de migración y **qué feature flag** se activará.
2. El super-admin aprueba. **Validado en el control plane** (token firmado), no en el prompt del LLM.
3. Merge a `main` → CI final → **Dokploy deploy**.
4. **Canary / blue-green**: sube la nueva versión a una fracción, health-check; si el error-rate sube →
   **rollback automático** a la imagen previa.
5. **Feature flags con Laravel Pennant** (first-party, con guidelines en Boost): la feature entra apagada;
   activarla es instantáneo y reversible sin redeploy.
6. **Backup automático** antes de cualquier migración; backup verificado, no solo ejecutado.

---

## 10. Guardrails de seguridad

- **Allowlist/denylist de rutas**: el agente no toca `config/`, `.env`, auth, billing, infra ni secretos.
- **Secretos fuera del sandbox**: se inyectan solo en runtime de prod vía Dokploy; el agente jamás los ve.
- **Egress allowlist** en el sandbox: solo packagist/npm/APIs de modelos. Sin acceso a prod ni a la DB real.
- **Aprobación no forjable**: el LLM no puede auto-aprobar; la firma la valida el control plane.
- **Defensa ante prompt-injection**: no se introduce contenido de usuarios finales en el contexto del agente.
- **Límites duros**: tope de tokens/tiempo por tarea, cuota diaria, kill-switch por tarea y global.
- **Audit log inmutable**: prompt, modelo usado, diff, resultados de gates, quién aprobó, deploy y rollback.

---

## 11. Optimización de recursos

- **Índice semántico en vez de re-lecturas** (§4.2) → menos tokens y menos I/O.
- **Router gratis-primero** → coste mínimo; los modelos de pago solo cuando aportan.
- **Contenedores efímeros** con imágenes warm y cachés persistentes de Composer/npm.
- **Cola de trabajos** (Redis + Horizon) en lugar de workers siempre vivos; el sandbox se levanta bajo demanda.
- **Prompt caching** y reutilización de prefijos (AGENTS.md/guidelines) para bajar coste de input.
- **Compartir contexto entre proyectos**: hechos/patrones globales reutilizables (wiki central).

---

## 12. Observabilidad y auditoría

- **App SaaS**: Laravel Nightwatch / Pulse / Telescope (errores, performance, queries).
- **Agente**: log de cada etapa, modelo, tokens y coste; panel de tareas en curso y su estado.
- **Deploy**: estado de Dokploy, health post-deploy, alertas y rollback automático.
- **Métricas de confianza**: nº de features desplegadas sin rollback por categoría → habilita auto-deploy.

---

## 13. Acceso multi-dispositivo

- El **chat es una web app (PWA)** del control plane → usable desde móvil/tablet/desktop.
- Alternativa/complemento: **bot de Telegram o Slack** que llama a la API del control plane.
- Auth fuerte: passkeys (Laravel 13 + Fortify) + 2FA para el super-admin.
- Notificaciones push cuando una feature está lista para aprobar o cuando algo falla.

---

## 14. Stack técnico concreto

| Capa | Tecnología |
|---|---|
| SaaS | Laravel 13 (PHP 8.3+) · Inertia v3 · TypeScript · Tailwind v4 · DaisyUI v5 |
| Contexto IA | **Laravel Boost** (`laravel/boost`) — MCP + guidelines + docs API |
| Flags | Laravel Pennant |
| Colas | Redis + Laravel Horizon |
| BD | PostgreSQL (+ pgvector para búsqueda semántica) |
| Control plane | Node/TS (orquestador) o Laravel (si se unifica) |
| Agente | OpenCode headless + Skill/Plugins + MCP |
| Modelos | OpenCode Zen (`opencode/*`, gratis) → OpenCode Go (`opencode-go/*`, pago) |
| Sandbox | Docker (imagen propia) / alternativas: E2B, Daytona |
| CI/CD | GitHub Actions / GitLab CI → **Dokploy** |
| E2E | Playwright (o Laravel Dusk) |
| Índice | SQLite FTS5 (barato) + embeddings opcionales (pgvector) |

---

## 15. Fases de implementación

1. **Fase 0 — Base**: template Laravel 13 + Inertia v3 + TW4 + DaisyUI5 + Boost instalado + Pest/Pint/PHPStan.
2. **Fase 1 — Memoria**: `AGENTS.md`, `.ai/rules/`, `memory/facts`, `memory/tasks`, índice FTS.
3. **Fase 2 — Router**: selección gratis→Go, fallback y rehidratación de contexto.
4. **Fase 3 — Sandbox**: imagen Docker + clonado + Boost MCP + agente headless.
5. **Fase 4 — Pipeline**: Planner/Coder/Verifier/Reviewer con gates Laravel+Inertia.
6. **Fase 5 — Preview + E2E**: deploy de rama a URL efímera + Playwright.
7. **Fase 6 — Aprobación + Dokploy**: compuerta humana + canary + rollback + Pennant.
8. **Fase 7 — Chat multi-dispositivo**: PWA/bot + passkeys + notificaciones.
9. **Fase 8 — Confianza**: métricas por categoría → auto-deploy con canary en casos seguros.

---

## 16. Límites honestos ("a prueba de errores")

"No existe el sistema perfecto", pero esto maximiza robustez con **defensa en profundidad**:

- La IA **puede equivocarse** → la contienen los gates + el reviewer + la aprobación humana + el rollback.
- El **canary + rollback** convierte un error en un incidente de segundos, no de horas.
- La **memoria en archivos + audit log** hace todo reproducible y auditable.
- Empezar en modo **asistido** (siempre aprobar) y habilitar autonomía solo donde las métricas lo respalden.


