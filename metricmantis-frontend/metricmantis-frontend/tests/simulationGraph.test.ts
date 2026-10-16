import assert from "node:assert/strict";
import test from "node:test";
import { applyCascadeFailure, parseComposeYaml, type ParsedService } from "../src/lib/composeParser";
import { graphCardStatus, graphEdgeView, graphNodeView, type SimulatedStatus } from "../src/lib/sandboxRuntime";

const SAMPLE = `services:
  web-app:
    image: nginx:alpine
    depends_on: [api]
  api:
    image: node:20-alpine
    depends_on: [db]
  db:
    image: postgres:16-alpine
`;

function statusOf(services: ParsedService[], name: string) {
  const found = services.find((service) => service.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found.status;
}

function card(status: SimulatedStatus) {
  return graphNodeView({
    simulatedStatus: status,
    observation: {
      verified: true,
      state: "running",
      health: "healthy",
      containerId: "a".repeat(64),
    },
    sandboxObserved: true,
    runtimeKnown: true,
  });
}

test("stopping web-app fails only that service", () => {
  const analysis = parseComposeYaml(SAMPLE);
  const next = applyCascadeFailure(analysis.services, analysis.edges, "web-app");
  assert.equal(statusOf(next, "web-app"), "down");
  assert.equal(statusOf(next, "api"), "healthy");
  assert.equal(statusOf(next, "db"), "healthy");

  const failed = card("down");
  const calm = card("healthy");
  assert.equal(graphCardStatus(failed), "down");
  assert.equal(failed.simulationLabel, "Simulation: Down");
  assert.equal(graphCardStatus(calm), "healthy");
  assert.equal(calm.simulationLabel, "Simulation: healthy");
  assert.equal(graphEdgeView("down", "healthy").tone, "down");
  assert.equal(graphEdgeView("healthy", "healthy").tone, "healthy");
});

test("stopping api degrades its dependent and leaves db unaffected", () => {
  const analysis = parseComposeYaml(SAMPLE);
  const next = applyCascadeFailure(analysis.services, analysis.edges, "api");
  assert.equal(statusOf(next, "api"), "down");
  assert.equal(statusOf(next, "web-app"), "degraded");
  assert.equal(statusOf(next, "db"), "healthy");

  const affected = card("degraded");
  assert.equal(graphCardStatus(affected), "degraded");
  assert.equal(affected.simulationLabel, "Simulation: affected");
  assert.equal(graphCardStatus(card("healthy")), "healthy");
  assert.equal(graphEdgeView("degraded", "down").tone, "down");
  assert.equal(graphEdgeView("down", "healthy").tone, "down");
});

test("stopping db propagates to direct and indirect dependents", () => {
  const analysis = parseComposeYaml(SAMPLE);
  const next = applyCascadeFailure(analysis.services, analysis.edges, "db");
  assert.equal(statusOf(next, "db"), "down");
  assert.equal(statusOf(next, "api"), "degraded");
  assert.equal(statusOf(next, "web-app"), "degraded");
  assert.notEqual(statusOf(next, "api"), statusOf(next, "db"));
  assert.notEqual(statusOf(next, "web-app"), statusOf(next, "db"));
});

test("simulated failure does not replace Docker state or health", () => {
  const down = card("down");
  const affected = card("degraded");
  const healthy = card("healthy");
  for (const view of [down, affected, healthy]) {
    assert.equal(view.tone, "healthy");
    assert.equal(view.dockerLabel, "Docker: running");
    assert.equal(view.healthLabel, "Health: healthy");
  }
  assert.equal(down.simulationTone, "down");
  assert.equal(affected.simulationTone, "degraded");
  assert.equal(healthy.simulationTone, "healthy");
  assert.equal(graphCardStatus(down), "down");
  assert.notEqual(graphCardStatus(down), down.tone);
});
