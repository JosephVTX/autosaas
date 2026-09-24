import { config } from "./config.js";

/**
 * Cliente mínimo de la API de Dokploy.
 * Auth por header `x-api-key`. Ver $DOKPLOY_URL/swagger.
 */

export type DokployResult<T = unknown> = { ok: boolean; status: number; data: T };

async function api<T = unknown>(path: string, body?: unknown): Promise<DokployResult<T>> {
  if (config.dryRun) {
    return { ok: true, status: 200, data: { dryRun: true, path, body } as T };
  }
  if (!config.dokployUrl || !config.dokployApiKey) {
    throw new Error("Dokploy no configurado (DOKPLOY_URL / DOKPLOY_API_KEY)");
  }
  const res = await fetch(`${config.dokployUrl}/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.dokployApiKey,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* texto plano */
  }
  return { ok: res.ok, status: res.status, data: data as T };
}

export type Application = {
  applicationId: string;
  name: string;
  applicationStatus?: string;
  customGitUrl?: string | null;
  customGitBranch?: string | null;
  buildType?: string | null;
  domains?: Array<{ host: string; port: number }>;
};

export const dokploy = {
  health: () => api("settings.health"),

  projectAll: () => api<unknown[]>("project.all"),

  async createApplication(input: {
    name: string;
    appName: string;
    description?: string;
    environmentId: string;
    projectId: string;
  }): Promise<Application> {
    const r = await api<Application>("application.create", input);
    if (!r.ok) throw new Error(`application.create falló: ${JSON.stringify(r.data)}`);
    return r.data;
  },

  saveGitProvider: (applicationId: string, customGitUrl: string, customGitBranch: string) =>
    api("application.saveGitProvider", { applicationId, customGitUrl, customGitBranch, sourceType: "git" }),

  saveBuildType: (applicationId: string, dockerfile = "Dockerfile") =>
    api("application.saveBuildType", { applicationId, buildType: "dockerfile", dockerfile }),

  saveEnvironment: (applicationId: string, env: string) =>
    api("application.saveEnvironment", { applicationId, env }),

  saveDomains: (
    applicationId: string,
    domains: Array<{ host: string; port: number; https?: boolean; certificateType?: string; path?: string }>,
  ) =>
    api(
      "application.saveDomains",
      {
        applicationId,
        domains: domains.map((d) => ({ https: true, certificateType: "letsencrypt", path: "/", ...d })),
      },
    ),

  deploy: (applicationId: string) => api("application.deploy", { applicationId }),

  one: async (applicationId: string): Promise<Application | null> => {
    const r = await api<Application>(`application.one?applicationId=${encodeURIComponent(applicationId)}`);
    return r.ok ? r.data : null;
  },

  /** Rollback lógico: redeploy de la revisión previa (Dokploy re-despliega el commit anterior). */
  rollback: (applicationId: string) => api("application.deploy", { applicationId }),
};

export function dokployConfigured(): boolean {
  return Boolean(config.dokployUrl && config.dokployApiKey);
}
