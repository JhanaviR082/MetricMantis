import assert from "node:assert/strict";
import test from "node:test";
import { applyControlledFault } from "../src/lib/chaosFaults";
import {
  applyCascadeFailure,
  parseComposeYaml,
  resetServiceHealth,
  type ParsedService,
} from "../src/lib/composeParser";
import { computeGraphLayout, getDependencyChain } from "../src/lib/graphLayout";
import { buildStructuredReport, type ChaosEvent } from "../src/lib/reportBuilder";
import { downloadReportPdf } from "../src/lib/reportPdf";

const SAMPLE = `services:
  web-app:
    image: nginx:alpine
    ports: ["3000:80"]
    depends_on: [api]
  api:
    image: node:20-alpine
    ports: ["8080:8080"]
    depends_on:
      db:
        condition: service_started
    environment:
      DB_PASSWORD: super-secret
  db:
    image: mysql:8.0
    ports: ["3306:3306"]
`;

function statusOf(services: ParsedService[], name: string) {
  return services.find((service) => service.name === name)?.status;
}

test("compose parser extracts services, dependencies, and secret keys only", () => {
  const analysis = parseComposeYaml(SAMPLE);
  assert.deepEqual(analysis.services.map((service) => service.name), ["web-app", "api", "db"]);
  assert.deepEqual(
    analysis.edges.map((edge) => `${edge.from}->${edge.to}`),
    ["web-app->api", "api->db"],
  );
  assert.equal(analysis.services.every((service) => service.status === "healthy"), true);
  const api = analysis.services.find((service) => service.name === "api");
  assert.deepEqual(api?.envKeys, ["DB_PASSWORD"]);
  assert.equal(api?.hasSecretEnv, true);
  assert.equal(JSON.stringify(analysis).includes("super-secret"), false);
});

test("compose parser rejects malformed, empty, and serviceless files", () => {
  assert.throws(() => parseComposeYaml("services: ["), /incomplete|invalid|end of the stream/i);
  assert.throws(
    () => parseComposeYaml("version: '3'\n"),
    /missing services section/,
  );
  assert.throws(() => parseComposeYaml("services: {}\n"), /No services found/);
});

test("unknown dependencies are ignored and isolated services stay unlinked", () => {
  const analysis = parseComposeYaml(`services:
  solo:
    image: alpine
  web:
    image: nginx
    depends_on: [missing]
`);
  assert.equal(analysis.edges.length, 0);
  assert.equal(analysis.services.length, 2);
});

test("cascade marks the target down and walks direct and indirect dependents", () => {
  const analysis = parseComposeYaml(SAMPLE);
  const next = applyCascadeFailure(analysis.services, analysis.edges, "db");
  assert.equal(statusOf(next, "db"), "down");
  assert.equal(statusOf(next, "api"), "degraded");
  assert.equal(statusOf(next, "web-app"), "degraded");
  assert.equal(resetServiceHealth(next).every((service) => service.status === "healthy"), true);
});

test("stopping an isolated service does not degrade the others", () => {
  const analysis = parseComposeYaml(`services:
  web:
    image: nginx
    depends_on: [api]
  api:
    image: node
  cache:
    image: redis
`);
  const next = applyCascadeFailure(analysis.services, analysis.edges, "cache");
  assert.equal(statusOf(next, "cache"), "down");
  assert.equal(statusOf(next, "web"), "healthy");
  assert.equal(statusOf(next, "api"), "healthy");
});

test("a dependency cycle terminates", () => {
  const analysis = parseComposeYaml(`services:
  a:
    image: alpine
    depends_on: [b]
  b:
    image: alpine
    depends_on: [a]
`);
  const next = applyCascadeFailure(analysis.services, analysis.edges, "a");
  assert.equal(statusOf(next, "a"), "down");
  assert.equal(statusOf(next, "b"), "degraded");
  const chain = getDependencyChain(analysis.services, analysis.edges);
  assert.equal(chain.includes("a"), true);
  assert.equal(chain.includes("b"), true);
});

test("controlled faults use degraded status and do not stack onto a down service", () => {
  const analysis = parseComposeYaml(SAMPLE);
  const latency = applyControlledFault(analysis.services, analysis.edges, "db", "latency");
  assert.deepEqual(latency.affected.sort(), ["api", "db"]);
  assert.equal(statusOf(latency.services, "web-app"), "healthy");
  assert.equal(latency.services.some((service) => service.status === "down"), false);

  const cpu = applyControlledFault(analysis.services, analysis.edges, "db", "cpu");
  assert.deepEqual(cpu.affected, ["db"]);
  assert.equal(statusOf(cpu.services, "api"), "healthy");

  const loss = applyControlledFault(analysis.services, analysis.edges, "api", "packet_loss");
  assert.deepEqual(loss.affected.sort(), ["api", "web-app"]);
  assert.equal(statusOf(loss.services, "db"), "healthy");

  const stopped = applyCascadeFailure(analysis.services, analysis.edges, "db");
  const stacked = applyControlledFault(stopped, analysis.edges, "db", "latency");
  assert.deepEqual(stacked.affected, []);
  assert.equal(statusOf(stacked.services, "db"), "down");
});

test("graph layout places the sample chain and survives a larger graph", () => {
  const analysis = parseComposeYaml(SAMPLE);
  const positions = computeGraphLayout(analysis.services, analysis.edges);
  assert.equal(positions.length, 3);
  const byName = Object.fromEntries(positions.map((position) => [position.id, position]));
  assert.ok(byName["web-app"].layer < byName.api.layer);
  assert.ok(byName.api.layer < byName.db.layer);
  assert.equal(getDependencyChain(analysis.services, analysis.edges), "db");

  const names = Array.from({ length: 40 }, (_, index) => `svc-${index}`);
  const services = names.map((name, index) => ({
    ...analysis.services[0],
    id: name,
    name,
    dependsOn: index === 0 ? [] : [names[index - 1]],
  }));
  const edges = services.slice(1).map((service, index) => ({
    from: service.name,
    to: names[index],
  }));
  const large = computeGraphLayout(services, edges);
  assert.equal(large.length, 40);
  assert.equal(large.every((position) => Number.isFinite(position.x) && Number.isFinite(position.y)), true);
  assert.equal(computeGraphLayout([], []).length, 0);
});

test("report names injected faults and handles a system with no experiments", () => {
  const analysis = parseComposeYaml(SAMPLE);
  const idle = buildStructuredReport(analysis.services, analysis.edges, [], analysis.restartPolicies);
  const chaos = idle.sections.find((section) => section.id === "chaos");
  assert.match(chaos?.paragraphs[0] ?? "", /No chaos experiments/);
  assert.ok(idle.scores.overall >= 1 && idle.scores.overall <= 10);

  const events: ChaosEvent[] = [
    { type: "latency", target: "db", command: "", at: "2026-10-09T08:00:00.000Z" },
    { type: "cpu", target: "api", command: "", at: "2026-10-09T08:01:00.000Z" },
    { type: "packet_loss", target: "api", command: "", at: "2026-10-09T08:02:00.000Z" },
    { type: "stop", target: "db", command: "docker stop db", at: "2026-10-09T08:03:00.000Z" },
    { type: "restart", target: undefined, command: "docker compose restart", at: "2026-10-09T08:04:00.000Z" },
  ];
  const ran = buildStructuredReport(analysis.services, analysis.edges, events, analysis.restartPolicies);
  const chaosText = (ran.sections.find((section) => section.id === "chaos")?.bullets ?? []).join("\n");
  const propagation = (ran.sections.find((section) => section.id === "propagation")?.bullets ?? []).join("\n");
  assert.match(chaosText, /Latency on db/);
  assert.match(chaosText, /CPU stress on api/);
  assert.match(chaosText, /Packet loss on api/);
  assert.match(chaosText, /docker stop db/);
  assert.match(chaosText, /Only the target was degraded/);
  assert.match(propagation, /Packet loss injected on api/);
  assert.equal(chaosText.includes("docker latency"), false);
});

test("PDF download writes a PDF named from the compose file", async () => {
  const analysis = parseComposeYaml(SAMPLE);
  const report = buildStructuredReport(analysis.services, analysis.edges, [], analysis.restartPolicies);
  const captured: Blob[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = ((blob: Blob) => {
    captured.push(blob);
    return "blob:metricmantis-test";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  const anchor = {
    href: "",
    download: "",
    rel: "",
    click() {},
    remove() {},
  };
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => anchor,
    body: { appendChild() {}, removeChild() {} },
  } as unknown as Document;

  try {
    downloadReportPdf({
      composeFileName: "sample-docker-compose.yml",
      sections: report.sections,
      scores: report.scores,
      criticalCount: 1,
      warningCount: 2,
    });
    assert.equal(anchor.download, "metricmantis-sample-docker-compose-report.pdf");
    assert.equal(captured.length, 1);
    const bytes = Buffer.from(await captured[0].arrayBuffer());
    const text = bytes.toString("latin1");
    assert.equal(text.startsWith("%PDF"), true);
    assert.match(text, /MetricMantis Resilience Report/);
    assert.match(text, /System Overview/);
    assert.match(text, /Chaos Experiment/);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    globalThis.document = previousDocument;
  }
});
