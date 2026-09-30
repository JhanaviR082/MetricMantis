import yaml from "js-yaml";

export type ServiceStatus = "healthy" | "degraded" | "down";

export interface ParsedService {
  id: string;
  name: string;
  image?: string;
  ports: string[];
  dependsOn: string[];
  restart?: string;
  status: ServiceStatus;
  // ── new fields ──────────────────────────────────────
  hasHealthcheck: boolean;
  volumes: string[];
  envKeys: string[];          // env var keys only (never values)
  hasSecretEnv: boolean;      // any key matching PASSWORD|SECRET|KEY|TOKEN|DSN
  networks: string[];
  isBuilt: boolean;           // has build: directive (no upstream image)
  replicas: number;           // deploy.replicas or 1
  command?: string;           // raw command string if present
}

export interface DependencyEdge {
  from: string;
  to: string;
}

export interface ReportFinding {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
}

export interface ComposeAnalysis {
  services: ParsedService[];
  edges: DependencyEdge[];
  findings: ReportFinding[];
  restartPolicies: Record<string, string | undefined>;
}

// ── raw compose types ────────────────────────────────────────────────────────

interface ComposeHealthcheck {
  test?: string | string[];
  interval?: string;
  timeout?: string;
  retries?: number;
}

interface ComposeDeploy {
  replicas?: number;
  mode?: string;
}

interface ComposeService {
  image?: string;
  build?: string | Record<string, unknown>;
  ports?: (string | number)[];
  depends_on?: string[] | Record<string, unknown>;
  links?: string[];
  restart?: string;
  healthcheck?: ComposeHealthcheck | { disable?: boolean };
  volumes?: (string | Record<string, unknown>)[];
  environment?: string[] | Record<string, string | null>;
  env_file?: string | string[];
  networks?: string[] | Record<string, unknown>;
  deploy?: ComposeDeploy;
  command?: string | string[];
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function normalizeDependsOn(
  raw: string[] | Record<string, unknown> | undefined,
): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  return Object.keys(raw);
}

function extractEnvKeys(
  env: string[] | Record<string, string | null> | undefined,
): string[] {
  if (!env) return [];
  if (Array.isArray(env)) return env.map((e) => e.split("=")[0]);
  return Object.keys(env);
}

const SECRET_PATTERN = /PASSWORD|SECRET|KEY|TOKEN|DSN|PASS|PRIVATE|CREDENTIAL/i;

function extractNetworks(
  raw: string[] | Record<string, unknown> | undefined,
): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  return Object.keys(raw);
}

function normalizeCommand(
  cmd: string | string[] | undefined,
): string | undefined {
  if (!cmd) return undefined;
  if (Array.isArray(cmd)) return cmd.join(" ");
  return cmd;
}

function hasActiveHealthcheck(hc: ComposeService["healthcheck"]): boolean {
  if (!hc) return false;
  if ("disable" in hc && hc.disable) return false;
  return true;
}

// ── main parser ──────────────────────────────────────────────────────────────

export function parseComposeYaml(text: string): ComposeAnalysis {
  const doc = yaml.load(text) as ComposeFile;
  if (!doc?.services || typeof doc.services !== "object") {
    throw new Error("Invalid compose file: missing services section");
  }

  const entries = Object.entries(doc.services);
  if (entries.length === 0) {
    throw new Error("No services found in docker-compose.yml");
  }

  const services: ParsedService[] = entries.map(([name, cfg]) => {
    const ports = (cfg.ports ?? []).map((p) => String(p));
    const dependsOn = [
      ...normalizeDependsOn(cfg.depends_on),
      ...(cfg.links ?? []).map((l) => l.split(":")[0]),
    ].filter((d, i, arr) => arr.indexOf(d) === i);

    const envKeys = extractEnvKeys(cfg.environment);
    const hasSecretEnv = envKeys.some((k) => SECRET_PATTERN.test(k));

    const volumes = (cfg.volumes ?? []).map((v) =>
      typeof v === "string" ? v : JSON.stringify(v),
    );

    const networks = extractNetworks(cfg.networks);
    const replicas = cfg.deploy?.replicas ?? 1;

    return {
      id: name,
      name,
      image: typeof cfg.image === "string" ? cfg.image : undefined,
      ports,
      dependsOn,
      restart: cfg.restart,
      status: "healthy",
      hasHealthcheck: hasActiveHealthcheck(cfg.healthcheck),
      volumes,
      envKeys,
      hasSecretEnv,
      networks,
      isBuilt: !!cfg.build && !cfg.image,
      replicas,
      command: normalizeCommand(cfg.command),
    };
  });

  const restartPolicies: Record<string, string | undefined> = {};
  for (const s of services) {
    restartPolicies[s.name] = s.restart;
  }

  const names = new Set(services.map((s) => s.name));
  const edges: DependencyEdge[] = [];
  for (const s of services) {
    for (const dep of s.dependsOn) {
      if (names.has(dep)) edges.push({ from: s.name, to: dep });
    }
  }

  const findings = buildFindings(services, edges);
  return { services, edges, findings, restartPolicies };
}

// ── findings builder ─────────────────────────────────────────────────────────

function buildFindings(
  services: ParsedService[],
  edges: DependencyEdge[],
): ReportFinding[] {
  const findings: ReportFinding[] = [];
  const dependants: Record<string, string[]> = {};

  for (const e of edges) {
    if (!dependants[e.to]) dependants[e.to] = [];
    dependants[e.to].push(e.from);
  }

  findings.push({
    id: "overview",
    severity: "info",
    title: `${services.length} services discovered`,
    detail: `Services: ${services.map((s) => s.name).join(", ")}. ${edges.length} dependency link(s) mapped.`,
  });

  // SPOF detection
  for (const [target, deps] of Object.entries(dependants)) {
    if (deps.length >= 2) {
      findings.push({
        id: `spof-${target}`,
        severity: "critical",
        title: `${target} is a potential single point of failure`,
        detail: `${deps.join(", ")} depend on ${target}. Failure cascades across the stack.`,
      });
    }
  }

  // DB-specific SPOF
  const dbLike = services.filter(
    (s) =>
      /db|database|mysql|postgres|mongo|redis/i.test(s.name) ||
      /mysql|postgres|mongo|redis/i.test(s.image ?? ""),
  );
  for (const db of dbLike) {
    const deps = dependants[db.name] ?? [];
    if (deps.length > 0) {
      findings.push({
        id: `db-spof-${db.name}`,
        severity: "critical",
        title: `Database ${db.name} has no replication`,
        detail: `${deps.join(", ")} depend on ${db.name}. Single container with no replica defined.`,
      });
    }
  }

  // Missing healthchecks
  for (const s of services) {
    if (!s.hasHealthcheck) {
      findings.push({
        id: `hc-${s.name}`,
        severity: "warning",
        title: `${s.name} has no healthcheck`,
        detail: `Without a healthcheck, Docker cannot detect failures in ${s.name} and depends_on conditions may pass prematurely.`,
      });
    }
  }

  // Missing restart policy
  for (const s of services) {
    if (!s.restart || s.restart === "no") {
      findings.push({
        id: `restart-${s.name}`,
        severity: "warning",
        title: `${s.name} has no restart policy`,
        detail: `${s.name} will not auto-recover after crash. Set restart: always or on-failure.`,
      });
    }
  }

  // Secret env vars in environment block
  for (const s of services) {
    if (s.hasSecretEnv) {
      findings.push({
        id: `secret-${s.name}`,
        severity: "warning",
        title: `${s.name} has secrets in environment block`,
        detail: `Keys ${s.envKeys.filter((k) => SECRET_PATTERN.test(k)).join(", ")} detected. Use Docker secrets or env_file with .gitignore protection.`,
      });
    }
  }

  // No volumes on DB-like services
  for (const db of dbLike) {
    if (db.volumes.length === 0) {
      findings.push({
        id: `vol-${db.name}`,
        severity: "critical",
        title: `${db.name} has no volume mount`,
        detail: `Data stored in ${db.name} will be lost on container restart. Add a named volume for persistence.`,
      });
    }
  }

  // Dependency chain info
  for (const s of services) {
    if (s.dependsOn.length > 0) {
      findings.push({
        id: `dep-${s.name}`,
        severity: "info",
        title: `${s.name} dependency chain`,
        detail: `${s.name} → ${s.dependsOn.join(", ")}. Disruptions propagate along this path.`,
      });
    }
  }

  return findings;
}

// ── existing exports (unchanged) ────────────────────────────────────────────

export function layoutNodes(services: ParsedService[]): Map<string, number> {
  const depth = new Map<string, number>();
  for (const s of services) depth.set(s.name, 0);

  for (let guard = 0; guard < 50; guard++) {
    let changed = false;
    for (const s of services) {
      for (const dep of s.dependsOn) {
        const next = (depth.get(dep) ?? 0) + 1;
        if (next > (depth.get(s.name) ?? 0)) {
          depth.set(s.name, next);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const maxDepth = Math.max(1, ...depth.values());
  const byDepth = new Map<number, string[]>();
  for (const s of services) {
    const d = depth.get(s.name) ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(s.name);
  }

  const positions = new Map<string, number>();
  for (const [d, names] of byDepth) {
    names.forEach((name, i) => {
      const layerPct = maxDepth <= 1 ? 50 : 8 + (d / maxDepth) * 72;
      const offset = names.length > 1 ? (i - (names.length - 1) / 2) * 6 : 0;
      positions.set(name, Math.min(88, Math.max(6, layerPct + offset)));
    });
  }

  return positions;
}

export function applyCascadeFailure(
  services: ParsedService[],
  edges: DependencyEdge[],
  failedId: string,
): ParsedService[] {
  const down = new Set<string>([failedId]);
  const degraded = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    for (const e of edges) {
      const depUnhealthy = down.has(e.to) || degraded.has(e.to);
      if (depUnhealthy && !down.has(e.from) && !degraded.has(e.from)) {
        degraded.add(e.from);
        changed = true;
      }
    }
  }

  return services.map((s) => {
    if (down.has(s.name)) return { ...s, status: "down" };
    if (degraded.has(s.name)) return { ...s, status: "degraded" };
    return { ...s, status: "healthy" };
  });
}

export function resetServiceHealth(services: ParsedService[]): ParsedService[] {
  return services.map((s) => ({ ...s, status: "healthy" as const }));
}