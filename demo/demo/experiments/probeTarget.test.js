const assert = require("node:assert/strict");
const test = require("node:test");
const { parseProbeUrl, prepareProbe, isBlockedAddress } = require("./probeTarget");

test("probe URLs reject credentials, redirects targets, and MetricMantis ports", () => {
  assert.equal(parseProbeUrl("http://user:pass@127.0.0.1:8080/", ["127.0.0.1"]).error.includes("credentials"), true);
  assert.equal(parseProbeUrl("http://127.0.0.1:8080\\@evil.test/", ["127.0.0.1"]).error.includes("plain"), true);
  assert.equal(parseProbeUrl("http://127.0.0.1:3001/health", ["127.0.0.1"]).error.includes("3001"), true);
  assert.equal(parseProbeUrl("http://169.254.169.254/", ["127.0.0.1"]).error.includes("ALLOWLIST"), true);
  assert.equal(parseProbeUrl("file:///etc/passwd", ["127.0.0.1"]).error.includes("http"), true);
});

test("link-local and metadata addresses are blocked even after DNS resolution", async () => {
  assert.equal(isBlockedAddress("169.254.169.254"), true);
  assert.equal(isBlockedAddress("127.0.0.1"), false);
  const resolved = await prepareProbe("http://localhost:8080/health", ["localhost"], async () => [
    { address: "169.254.169.254" },
  ]);
  assert.equal(resolved.error.includes("blocked"), true);
  const pinned = await prepareProbe("http://127.0.0.1:8080/health", ["127.0.0.1"]);
  assert.equal(pinned.fetchUrl, "http://127.0.0.1:8080/health");
});
