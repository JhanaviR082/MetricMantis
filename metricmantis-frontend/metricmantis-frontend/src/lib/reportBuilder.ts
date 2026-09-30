import type { DependencyEdge, ParsedService } from "@/lib/composeParser";
import { getDependencyChain } from "@/lib/graphLayout";

export interface ChaosEvent {
  type: "stop" | "restart";
  target?: string;
  command: string;
  at: string;
}

export interface ResilienceScores {
  dependencySafety: number;
  faultTolerance: number;
  recoveryCapability: number;
  monitoringVisibility: number;
  overall: number;
}

export interface ReportSection {
  id: string;
  number: string;
  title: string;
  paragraphs: string[];
  bullets?: string[];
  table?: { label: string; score: string }[];
  code?: string;
  log?: string;
}

// ── type guards ───────────────────────────────────────────────────────────────

function isDbLike(s: ParsedService): boolean {
  return (
    /db|database|mysql|postgres|mongo|redis/i.test(s.name) ||
    /mysql|postgres|mongo|redis/i.test(s.image ?? "")
  );
}

function isCacheLike(s: ParsedService): boolean {
  return /redis|memcache|cache/i.test(s.name) || /redis|memcache/i.test(s.image ?? "");
}

function isWebLike(s: ParsedService): boolean {
  return /web|frontend|nginx|caddy|proxy|client/i.test(s.name);
}

function isApiLike(s: ParsedService): boolean {
  return /api|backend|server|app|service/i.test(s.name) && !isDbLike(s) && !isWebLike(s);
}

// ── SPOF detection ────────────────────────────────────────────────────────────

function buildDependantsMap(edges: DependencyEdge[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const e of edges) {
    if (!map[e.to]) map[e.to] = [];
    map[e.to].push(e.from);
  }
  return map;
}

function findSpofs(services: ParsedService[], edges: DependencyEdge[]): ParsedService[] {
  const dependants = buildDependantsMap(edges);
  return services.filter((s) => (dependants[s.name]?.length ?? 0) >= 2);
}

// ── scoring ───────────────────────────────────────────────────────────────────

function computeScores(
  services: ParsedService[],
  edges: DependencyEdge[],
  chaosEvents: ChaosEvent[],
): ResilienceScores {
  const dependants = buildDependantsMap(edges);
  const spofCount = services.filter((s) => (dependants[s.name]?.length ?? 0) >= 2).length;
  const missingHcOnDeps = services.filter(
    (s) => !s.hasHealthcheck && (dependants[s.name]?.length ?? 0) > 0,
  ).length;
  const dependencySafety = Math.max(1, Math.min(10, 10 - spofCount * 2 - missingHcOnDeps));

  const noRestart = services.filter((s) => !s.restart || s.restart === "no").length;
  const dbNoVolume = services.filter(
  (s) => isDbLike(s) && (s.volumes?.length ?? 0) === 0,
).length;
  const faultTolerance = Math.max(1, Math.min(10,
    10 - spofCount * 1.5 - noRestart * 0.8 - dbNoVolume * 2,
  ));

  const hasAnyRestart = services.some((s) => s.restart && s.restart !== "no");
  const restartRan = chaosEvents.some((e) => e.type === "restart");
  const recoveryCapability = Math.min(10,
    5 + (hasAnyRestart ? 3 : 0) + (restartRan ? 2 : 0) - (noRestart > services.length / 2 ? 2 : 0),
  );

  const hcCount = services.filter((s) => s.hasHealthcheck).length;
  const hcRatio = services.length > 0 ? hcCount / services.length : 0;
  const chaosRan = chaosEvents.some((e) => e.type === "stop");
  const monitoringVisibility = Math.min(10, Math.round(hcRatio * 7) + (chaosRan ? 2 : 0) + 1);

  const overall =
    Math.round(
      ((dependencySafety + faultTolerance + recoveryCapability + monitoringVisibility) / 4) * 10,
    ) / 10;

  return {
    dependencySafety: Math.round(dependencySafety * 10) / 10,
    faultTolerance: Math.round(faultTolerance * 10) / 10,
    recoveryCapability: Math.round(recoveryCapability * 10) / 10,
    monitoringVisibility: Math.round(monitoringVisibility * 10) / 10,
    overall,
  };
}

// ── log simulator ─────────────────────────────────────────────────────────────

function simulateLog(target: string, down: ParsedService[], degraded: ParsedService[]): string {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const lines: string[] = [];

  if (isDbLike({ name: target } as ParsedService)) {
    lines.push(`${ts} ERROR [${target}] Connection refused: dial tcp :5432`);
    for (const s of down) lines.push(`${ts} FATAL [${s.name}] Failed to acquire DB connection — exiting`);
    for (const s of degraded) lines.push(`${ts} WARN  [${s.name}] Dependency ${target} unreachable — serving degraded`);
  } else if (isApiLike({ name: target } as ParsedService)) {
    lines.push(`${ts} ERROR [${target}] health check failed: status 0`);
    for (const s of degraded) lines.push(`${ts} WARN  [${s.name}] Upstream ${target} not responding — 502 on /api/*`);
  } else {
    lines.push(`${ts} ERROR [${target}] container exited with code 137`);
    for (const s of degraded) lines.push(`${ts} WARN  [${s.name}] dependency ${target} is down — partial failure`);
  }

  lines.push(`${ts} INFO  chaos: ${down.length} down, ${degraded.length} degraded`);
  return lines.join("\n");
}

// ── section builders ──────────────────────────────────────────────────────────

function buildOverview(services: ParsedService[], edges: DependencyEdge[]): ReportSection {
  const dbServices = services.filter(isDbLike);
  const webServices = services.filter(isWebLike);
  const apiServices = services.filter(isApiLike);
  const cacheServices = services.filter(isCacheLike);
  const builtServices = services.filter((s) => s.isBuilt);
  const imageServices = services.filter((s) => !!s.image);

  const layerDesc: string[] = [];
  if (webServices.length) layerDesc.push(`${webServices.length} frontend/proxy layer (${webServices.map(s => s.name).join(", ")})`);
  if (apiServices.length) layerDesc.push(`${apiServices.length} application layer (${apiServices.map(s => s.name).join(", ")})`);
  if (dbServices.length) layerDesc.push(`${dbServices.length} data layer (${dbServices.map(s => s.name).join(", ")})`);
  if (cacheServices.length) layerDesc.push(`${cacheServices.length} cache layer (${cacheServices.map(s => s.name).join(", ")})`);

  const imageSummary = imageServices.map((s) => `${s.name} uses ${s.image}`).join("; ");
  const buildNote = builtServices.length
    ? `${builtServices.map((s) => s.name).join(", ")} ${builtServices.length === 1 ? "is" : "are"} built locally via Dockerfile.`
    : "";

  return {
    id: "overview",
    number: "1",
    title: "System Overview",
    paragraphs: [
      `The uploaded Docker Compose file defines ${services.length} service${services.length === 1 ? "" : "s"} with ${edges.length} explicit dependency link${edges.length === 1 ? "" : "s"}.`,
      layerDesc.length
        ? `Architecture layers detected: ${layerDesc.join("; ")}.`
        : "No clear architectural layering detected — services may be peers or missing depends_on declarations.",
      imageSummary ? `Image inventory: ${imageSummary}.` : "",
      buildNote,
    ].filter(Boolean),
    bullets: services.map((s) => {
      const tags: string[] = [];
      if (isDbLike(s)) tags.push("database");
      if (isWebLike(s)) tags.push("frontend");
      if (isApiLike(s)) tags.push("api");
      if (isCacheLike(s)) tags.push("cache");
      if (s.ports.length) tags.push(`ports: ${s.ports.join(", ")}`);
      if (s.restart && s.restart !== "no") tags.push(`restart: ${s.restart}`);
      if (s.hasHealthcheck) tags.push("✓ healthcheck");
      if (s.volumes?.length) tags.push(`volumes: ${s.volumes.length}`);
      return `${s.name}${tags.length ? ` — ${tags.join(" · ")}` : ""}`;
    }),
  };
}

function buildGraphAnalysis(services: ParsedService[], edges: DependencyEdge[]): ReportSection {
  const dependants = buildDependantsMap(edges);
  const chain = getDependencyChain(services, edges);
  const roots = services.filter(
    (s) => s.dependsOn.length === 0 && (dependants[s.name]?.length ?? 0) > 0,
  );
  const bullets: string[] = [];

  if (roots.length) {
    bullets.push(`Root services (no upstream deps): ${roots.map((s) => s.name).join(", ")} — foundational; failure propagates upward.`);
  }

  for (const s of services.filter((s) => s.dependsOn.length > 0)) {
    const fanIn = dependants[s.name]?.length ?? 0;
    bullets.push(
      `${s.name} → depends on [${s.dependsOn.join(", ")}]${fanIn > 0 ? `, and is a dependency for ${fanIn} other service(s)` : ""}.`,
    );
  }

  if (edges.length === 0) {
    bullets.push("No depends_on links found. Add depends_on to model startup ordering and failure propagation accurately.");
  }

  return {
    id: "graph-analysis",
    number: "2",
    title: "Dependency Graph Analysis",
    paragraphs: [
      `${edges.length} dependency edge${edges.length === 1 ? "" : "s"} mapped across ${services.length} services.`,
      chain ? `Resolved startup chain: ${chain}` : "No resolvable dependency chain.",
    ],
    bullets,
  };
}

function buildSpof(services: ParsedService[], edges: DependencyEdge[]): ReportSection {
  const dependants = buildDependantsMap(edges);
  const spofs = findSpofs(services, edges);
  const dbDeps = services.filter((s) => isDbLike(s) && (dependants[s.name]?.length ?? 0) > 0 && !spofs.includes(s));

  if (spofs.length === 0 && dbDeps.length === 0) {
    return {
      id: "spof",
      number: "3",
      title: "Single Point of Failure Detection",
      paragraphs: [
        "No services with 2+ dependants detected from the compose graph.",
        "This does not guarantee the absence of SPOFs — runtime coupling not declared via depends_on is invisible here.",
      ],
      bullets: ["Review shared queues, caches, or external APIs not modelled in compose.", "Consider load testing to surface undeclared coupling."],
    };
  }

  const bullets: string[] = [];
  for (const s of [...spofs, ...dbDeps]) {
    const deps = dependants[s.name] ?? [];
    const type = isDbLike(s) ? "Database" : isCacheLike(s) ? "Cache" : "Shared service";
    bullets.push(`${s.name} (${type}) — ${deps.length} dependant(s): ${deps.join(", ")}. No replica declared.`);
if (isDbLike(s) && (s.volumes?.length ?? 0) === 0) bullets.push(`↳ ${s.name} has no volume — data loss on restart is certain.`);
    if (!s.hasHealthcheck) bullets.push(`↳ ${s.name} has no healthcheck — dependants may connect before it is ready.`);
  }

  return {
    id: "spof",
    number: "3",
    title: "Single Point of Failure Detection",
    paragraphs: [`${spofs.length + dbDeps.length} potential single point${spofs.length + dbDeps.length === 1 ? "" : "s"} of failure detected.`],
    bullets,
  };
}

function buildChaosSection(services: ParsedService[], edges: DependencyEdge[], chaosEvents: ChaosEvent[]): ReportSection {
  const stopEvents = chaosEvents.filter((e) => e.type === "stop");
  const restartEvents = chaosEvents.filter((e) => e.type === "restart");

  if (stopEvents.length === 0) {
    return {
      id: "chaos",
      number: "4",
      title: "Chaos Experiment Summary",
      paragraphs: ["No chaos experiments run yet. Use the Chaos Controls page to inject failures."],
      bullets: services.map((s) => `${s.name} — candidate for injection${isDbLike(s) ? " (⚠ high blast radius)" : ""}`),
    };
  }

  const dependants = buildDependantsMap(edges);
  const bullets: string[] = [];

  for (const ev of stopEvents) {
    const target = ev.target ?? "unknown";
    const deps = dependants[target] ?? [];
    bullets.push(`Stopped: ${target} at ${new Date(ev.at).toLocaleTimeString()} — \`${ev.command}\``);
    if (deps.length) bullets.push(`↳ Cascade affected: ${deps.join(", ")}.`);
  }

  if (restartEvents.length) {
    const last = restartEvents[restartEvents.length - 1];
    bullets.push(`Recovery: "${last.command}" at ${new Date(last.at).toLocaleTimeString()}`);
  }

  const lastStop = stopEvents[stopEvents.length - 1];
  return {
    id: "chaos",
    number: "4",
    title: "Chaos Experiment Summary",
    paragraphs: [
      `${stopEvents.length} failure injection${stopEvents.length === 1 ? "" : "s"}, ${restartEvents.length} recovery event${restartEvents.length === 1 ? "" : "s"}.`,
    ],
    code: lastStop?.command,
    bullets,
  };
}

function buildPropagation(services: ParsedService[], chaosEvents: ChaosEvent[]): ReportSection {
  const down = services.filter((s) => s.status === "down");
  const degraded = services.filter((s) => s.status === "degraded");
  const lastStop = [...chaosEvents].reverse().find((e) => e.type === "stop");

  if (!lastStop && down.length === 0 && degraded.length === 0) {
    return {
      id: "propagation",
      number: "5",
      title: "Failure Propagation Analysis",
      paragraphs: ["All services healthy. Run a chaos experiment to populate this section."],
    };
  }

  return {
    id: "propagation",
    number: "5",
    title: "Failure Propagation Analysis",
    paragraphs: [`Current state: ${down.length} service${down.length === 1 ? "" : "s"} down, ${degraded.length} degraded.`],
    bullets: [
      ...down.map((s) => `${s.name} — STOPPED. ${isDbLike(s) ? "Data writes halted." : isWebLike(s) ? "User traffic blocked." : "Service unavailable."}`),
      ...degraded.map((s) => `${s.name} — DEGRADED. ${isApiLike(s) ? "API endpoints erroring." : "Functionality partially impaired."}`),
    ],
    log: lastStop && (down.length || degraded.length)
      ? simulateLog(lastStop.target ?? "", down, degraded)
      : undefined,
  };
}

function buildRecovery(
  services: ParsedService[],
  chaosEvents: ChaosEvent[],
  restartPolicies: Record<string, string | undefined>,
): ReportSection {
  const withPolicy = services.filter((s) => s.restart && s.restart !== "no");
  const withoutPolicy = services.filter((s) => !s.restart || s.restart === "no");
  const restartRan = chaosEvents.some((e) => e.type === "restart");
  const bullets: string[] = [];

  if (withPolicy.length) bullets.push(`Auto-restart configured: ${withPolicy.map((s) => `${s.name} (${s.restart})`).join(", ")}.`);
  if (withoutPolicy.length) bullets.push(`No restart policy: ${withoutPolicy.map((s) => s.name).join(", ")} — manual recovery required on crash.`);
  for (const s of withoutPolicy.filter(isDbLike)) bullets.push(`↳ ${s.name} is a database with no restart policy — unhandled crash risks data corruption.`);
  if (restartRan) bullets.push("Restart All executed this session — services returned to healthy in simulation.");
  else if (chaosEvents.some((e) => e.type === "stop")) bullets.push("Failure injected but no recovery event recorded yet.");

  return {
    id: "recovery",
    number: "6",
    title: "Recovery Analysis",
    paragraphs: [
      withPolicy.length
        ? `${withPolicy.length} of ${services.length} services have a restart policy.`
        : `None of the ${services.length} services define a restart policy — the system will not self-heal.`,
    ],
    bullets,
  };
}

function buildScores(scores: ResilienceScores): ReportSection {
  return {
    id: "scores",
    number: "7",
    title: "Resilience Score",
    paragraphs: [`Overall Resilience Score: ${scores.overall}/10`],
    table: [
      { label: "Dependency Safety", score: `${scores.dependencySafety}/10` },
      { label: "Fault Tolerance", score: `${scores.faultTolerance}/10` },
      { label: "Recovery Capability", score: `${scores.recoveryCapability}/10` },
      { label: "Monitoring Visibility", score: `${scores.monitoringVisibility}/10` },
    ],
  };
}

function buildRisks(services: ParsedService[], edges: DependencyEdge[]): ReportSection {
  const dependants = buildDependantsMap(edges);
  const bullets: string[] = [];

  for (const s of services) {
    const fanIn = dependants[s.name]?.length ?? 0;
    if (fanIn >= 2) bullets.push(`${s.name} outage cascades to ${dependants[s.name].join(", ")} simultaneously — no fallback defined.`);
  }

  for (const s of services.filter((s) => isDbLike(s) && s.volumes.length === 0)) {
    bullets.push(`${s.name} has no persistent volume — container restart causes total data loss.`);
  }

  for (const s of services.filter((s) => s.hasSecretEnv)) {
    const keys = s.envKeys.filter((k) => /PASSWORD|SECRET|KEY|TOKEN|DSN|PASS|PRIVATE|CREDENTIAL/i.test(k));
    bullets.push(`${s.name} exposes sensitive env keys (${keys.join(", ")}) — credential leak risk via docker inspect or CI logs.`);
  }

  for (const s of services) {
    if (!s.hasHealthcheck && (dependants[s.name]?.length ?? 0) > 0) {
      bullets.push(`${s.name} has no healthcheck but ${dependants[s.name].join(", ")} depend on it — startup race conditions likely.`);
    }
  }

  for (const s of services.filter((s) => s.ports.some((p) => !p.startsWith("127.0.0.1")))) {
    const ext = s.ports.filter((p) => !p.startsWith("127.0.0.1"));
    bullets.push(`${s.name} binds external port(s) ${ext.join(", ")} — ensure firewall rules restrict access in production.`);
  }

  if (bullets.length === 0) bullets.push("No high-severity risks detected from compose configuration.");

  return {
    id: "risks",
    number: "8",
    title: "Production Risk Assessment",
    paragraphs: [`${bullets.length} risk factor${bullets.length === 1 ? "" : "s"} identified:`],
    bullets,
  };
}

function buildRecommendations(services: ParsedService[], edges: DependencyEdge[]): ReportSection {
  const dependants = buildDependantsMap(edges);
  const bullets: string[] = [];

  for (const s of services) {
    if (!s.hasHealthcheck) {
      const test = isDbLike(s)
        ? `["CMD", "pg_isready", "-U", "postgres"]`
        : isWebLike(s)
          ? `["CMD", "curl", "-f", "http://localhost/health"]`
          : `["CMD", "wget", "-q", "--spider", "http://localhost"]`;
      bullets.push(`Add healthcheck to ${s.name}: \`test: ${test}\``);
    }

    if (!s.restart || s.restart === "no") {
      bullets.push(`Set \`restart: ${isDbLike(s) ? "always" : "on-failure"}\` on ${s.name}.`);
    }

    if (isDbLike(s) && s.volumes.length === 0) {
      bullets.push(`Mount a named volume on ${s.name} (e.g. \`${s.name}_data:/var/lib/postgresql/data\`).`);
    }

    if (s.hasSecretEnv) {
      bullets.push(`Move secrets from ${s.name} environment block to a \`.env\` file or Docker secrets.`);
    }
  }

  for (const s of services.filter((s) => (dependants[s.name]?.length ?? 0) >= 2)) {
    if (isDbLike(s)) {
      bullets.push(`${s.name} is a DB SPOF — add a read-replica or managed database with automatic failover.`);
    } else {
      bullets.push(`${s.name} has ${dependants[s.name].length} dependants — consider multiple replicas or extracting to a managed service.`);
    }
  }

  if (services.some((s) => !s.hasHealthcheck && s.dependsOn.length > 0)) {
    bullets.push("Use \`condition: service_healthy\` in depends_on blocks to enforce correct startup ordering.");
  }

  if (!services.some((s) => s.networks.length > 0)) {
    bullets.push("Define explicit networks to isolate frontend ↔ backend ↔ database tiers.");
  }

  bullets.push("Add a circuit-breaker or retry library at the API layer (e.g. resilience4j, axios-retry) to handle transient dependency failures.");

  return {
    id: "recommendations",
    number: "9",
    title: "Engineering Recommendations",
    paragraphs: [`${bullets.length} targeted recommendation${bullets.length === 1 ? "" : "s"} based on your compose file:`],
    bullets,
  };
}

// ── public API ────────────────────────────────────────────────────────────────

export function buildStructuredReport(
  services: ParsedService[],
  edges: DependencyEdge[],
  chaosEvents: ChaosEvent[],
  restartPolicies: Record<string, string | undefined>,
): { sections: ReportSection[]; scores: ResilienceScores } {
  const scores = computeScores(services, edges, chaosEvents);
  const sections: ReportSection[] = [
    buildOverview(services, edges),
    buildGraphAnalysis(services, edges),
    buildSpof(services, edges),
    buildChaosSection(services, edges, chaosEvents),
    buildPropagation(services, chaosEvents),
    buildRecovery(services, chaosEvents, restartPolicies),
    buildScores(scores),
    buildRisks(services, edges),
    buildRecommendations(services, edges),
  ];
  return { sections, scores };
}