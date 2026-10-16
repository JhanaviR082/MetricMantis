const { APPROVED_SERVICES, AUXILIARY_SERVICES } = require("../sandboxes/sandboxRuntime");
const { isSafeServiceName } = require("../experiments/dockerExecutor");

function approvedChaosAllowlist() {
  const names = APPROVED_SERVICES.filter((name) => (
    isSafeServiceName(name) && !AUXILIARY_SERVICES.includes(name)
  ));
  if (names.length !== APPROVED_SERVICES.length || names.length === 0) {
    throw new Error("Approved sandbox services are not a safe chaos allowlist.");
  }
  return names;
}

function localChaosEnvironment(baseEnv = {}) {
  return {
    ...baseEnv,
    METRICMANTIS_CHAOS_ENABLED: "true",
    METRICMANTIS_CHAOS_ALLOWLIST: approvedChaosAllowlist().join(","),
  };
}

function startLocalChaos() {
  return require("./startApi").runStartup("chaos");
}

module.exports = { approvedChaosAllowlist, localChaosEnvironment, startLocalChaos };

if (require.main === module) startLocalChaos();
