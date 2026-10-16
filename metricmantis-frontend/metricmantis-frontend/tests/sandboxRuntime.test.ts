import assert from "node:assert/strict";
import test from "node:test";
import { applyControlledFault } from "../src/lib/chaosFaults";
import { parseComposeYaml, type ParsedService } from "../src/lib/composeParser";
import { graphEdgeView, graphNodeView, observedServicesMissingFromGraph, runtimeDisplay, type ServiceRuntime } from "../src/lib/sandboxRuntime";

const SAMPLE = `services:
  web:
    image: nginx:alpine
    depends_on: [api]
  api:
    image: node:20-alpine
`;

function service(services: ParsedService[], name: string) {
  const found = services.find((item) => item.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

test("docker runtime status stays separate from simulated chaos", () => {
  const analysis = parseComposeYaml(SAMPLE);
  assert.equal(runtimeDisplay({ verified: true, state: "running", health: "healthy" }), "healthy");
  assert.equal(runtimeDisplay({ verified: true, state: "running", health: "" }), "running");
  assert.equal(runtimeDisplay({ verified: true, state: "running", health: "unknown" }), "running");
  assert.equal(runtimeDisplay({ verified: true, state: "running", health: "unhealthy" }), "unhealthy");
  assert.equal(runtimeDisplay({ verified: true, state: "exited", health: "" }), "exited");
  assert.equal(runtimeDisplay({ verified: false, state: "running", health: "healthy" }), "unknown");

  const simulated = applyControlledFault(analysis.services, analysis.edges, "web", "cpu");
  const web = service(simulated.services, "web");
  assert.equal(web.status, "degraded");

  const live = graphNodeView({
    simulatedStatus: web.status,
    simulatedFault: "CPU saturation",
    observation: { verified: true, state: "running", health: "healthy" },
    sandboxObserved: true,
    runtimeKnown: true,
  });
  assert.equal(live.source, "docker");
  assert.equal(live.tone, "healthy");
  assert.equal(live.dockerLabel, "Docker: running");
  assert.equal(live.healthLabel, "Health: healthy");
  assert.equal(live.simulationLabel, "Simulation: CPU saturation");

  const afterAnotherClick = graphNodeView({
    simulatedStatus: "down",
    observation: { verified: true, state: "running", health: "healthy" },
    sandboxObserved: true,
    runtimeKnown: true,
  });
  assert.equal(afterAnotherClick.tone, live.tone);
  assert.equal(afterAnotherClick.dockerLabel, live.dockerLabel);
  assert.equal(afterAnotherClick.healthLabel, live.healthLabel);
  assert.equal(afterAnotherClick.simulationLabel, "Simulation: Down");

  const noHealth = graphNodeView({
    simulatedStatus: "healthy",
    observation: { verified: true, state: "running", health: "unknown" },
    sandboxObserved: true,
    runtimeKnown: true,
  });
  assert.equal(noHealth.tone, "running");
  assert.equal(noHealth.dockerLabel, "Docker: running");
  assert.equal(noHealth.healthLabel, "Health: unknown");
  assert.equal(noHealth.simulationLabel, "Simulation: healthy");

  const missing = graphNodeView({
    simulatedStatus: web.status,
    simulatedFault: "CPU saturation",
    observation: null,
    sandboxObserved: true,
    runtimeKnown: true,
  });
  assert.equal(missing.tone, "absent");
  assert.equal(missing.dockerLabel, "Docker: Not running in sandbox");
  assert.equal(missing.healthLabel, null);
  assert.equal(missing.simulationLabel, "Simulation: CPU saturation");

  const unread = graphNodeView({
    simulatedStatus: "healthy",
    observation: null,
    sandboxObserved: true,
    runtimeKnown: false,
  });
  assert.equal(unread.dockerLabel, "Docker: Unknown");
  assert.equal(unread.healthLabel, null);

  const recordedButAbsent = graphNodeView({
    simulatedStatus: "healthy",
    observation: { verified: false, state: "unknown", health: "unknown", containerId: null },
    sandboxObserved: false,
    runtimeKnown: true,
  });
  assert.equal(recordedButAbsent.dockerLabel, "Docker: Not running in sandbox");
  assert.equal(recordedButAbsent.healthLabel, null);
  assert.equal(recordedButAbsent.tone, "absent");

  const mismatched = graphNodeView({
    simulatedStatus: "down",
    observation: { verified: false, state: "running", health: "healthy", containerId: null },
    sandboxObserved: true,
    runtimeKnown: true,
    inspectionFailed: true,
  });
  assert.equal(mismatched.tone, "unknown");
  assert.equal(mismatched.dockerLabel, "Docker: Unknown");
  assert.equal(mismatched.healthLabel, null);
  assert.equal(mismatched.simulationLabel, "Simulation: Down");

  const beforeSandbox = graphNodeView({
    simulatedStatus: web.status,
    observation: null,
    sandboxObserved: false,
  });
  assert.equal(beforeSandbox.tone, "absent");
  assert.equal(beforeSandbox.dockerLabel, "Docker: Not running in sandbox");
  assert.equal(beforeSandbox.simulationLabel, "Simulation: affected");

  const edge = graphEdgeView("down", "healthy");
  assert.equal(edge.label, "Simulation");
  assert.equal(edge.tone, "down");
  const calmEdge = graphEdgeView("healthy", "healthy");
  assert.equal(calmEdge.label, "Simulation");
  assert.equal(calmEdge.tone, "healthy");
});

test("a verified sandbox service is kept when the analyzed graph uses different names", () => {
  const web: ServiceRuntime = {
    service: "web",
    containerId: "a".repeat(64),
    state: "running",
    health: "healthy",
    display: "healthy",
    verified: true,
  };
  const missing = observedServicesMissingFromGraph(["web-app", "api", "db"], [web]);
  assert.deepEqual(missing.map((service) => service.service), ["web"]);
  const sandboxNode = graphNodeView({
    observation: missing[0],
    sandboxObserved: true,
    runtimeKnown: true,
  });
  assert.equal(sandboxNode.dockerLabel, "Docker: running");
  assert.equal(sandboxNode.healthLabel, "Health: healthy");
  assert.equal(sandboxNode.simulationLabel, null);

  const uploaded = graphNodeView({
    simulatedStatus: "healthy",
    observation: null,
    sandboxObserved: true,
    runtimeKnown: true,
  });
  assert.equal(uploaded.dockerLabel, "Docker: Not running in sandbox");
  assert.equal(uploaded.healthLabel, null);
  assert.equal(uploaded.simulationLabel, "Simulation: healthy");
  assert.deepEqual(observedServicesMissingFromGraph(["web", "api"], [web]), []);
});

test("graph services keep verified Docker health apart from simulation", () => {
  const names = ["web-app", "api", "db"] as const;
  for (const name of names) {
    const view = graphNodeView({
      simulatedStatus: "degraded",
      simulatedFault: "CPU stress",
      observation: { verified: true, state: "running", health: "healthy", containerId: "a".repeat(64) },
      sandboxObserved: true,
      runtimeKnown: true,
    });
    assert.equal(view.dockerLabel, "Docker: running");
    assert.equal(view.healthLabel, "Health: healthy");
    assert.equal(view.simulationLabel, "Simulation: CPU stress");
    assert.equal(view.tone, "healthy");
    assert.equal(name.length > 0, true);
  }
  const edge = graphEdgeView("degraded", "healthy");
  assert.equal(edge.label, "Simulation");
  assert.equal(edge.tone, "degraded");
});
