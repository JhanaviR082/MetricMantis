# Measured experiments

The Chaos page still has a simulation: its row buttons change the graph in the browser and do not touch containers. The Configure Experiment panel calls `POST /experiments`. That route returns `202` with status `RUNNING`, and the Observability Dashboard polls `GET /experiments/:id` until the run finishes. `POST /experiments/:id/cancel` aborts a run that is still active. Measure-only records the baseline probe window. It does not open a fault or recovery window and it does not change a container.

## What is real

- **Measure only** sends HTTP requests to an allowlisted probe URL and records counts, status codes, error rate, throughput, and latency.
- **Stop, restart, and CPU limit** call `docker stop`, `docker start`, `docker restart`, or `docker update` only when `METRICMANTIS_CHAOS_ENABLED=true` and the target is in `METRICMANTIS_CHAOS_ALLOWLIST`.
- Stop is checked with `docker inspect` before and after. The fault counts only when the container was running and then was not. Cleanup runs `docker start` unless inspect still shows it running.
- Restart counts only when inspect shows the container was running, is running again, and `State.StartedAt` is newer. Docker's `RestartCount` is the restart-policy counter, so `docker restart` does not increase it.
- CPU limit sets `--cpu-quota 5000` and `--cpu-period 100000` (about 5% of one core). It counts only when a later inspect shows quota `5000`. Before the baseline window, the API starts a bounded `timeout` + `dd` workload inside the allowlisted container so the limit has work to throttle. The workload is stopped in cleanup, and it also stops itself when its timeout ends. Request count, probe completion rate, error rate, p50, p95, and one `docker stats` CPU sample are recorded for the baseline, CPU-limited, and recovery windows. The pass covers the inspect check, the observed workload, cleanup, and the recovery error-rate threshold. Probe completion rate follows the configured send rate. It is not service capacity. The CPU percentage is one sample and is not a pass or a significance test. p95 is shown separately and one window is not a consistent latency effect. A missing sample stays unavailable. It is not stored as zero. Cleanup passes `--cpu-quota -1` when the previous quota was unlimited (`0` or `-1`), because Docker does not clear a quota with `0`. Cleanup counts only when a later inspect shows that quota again. If the first restore does not verify, cleanup tries once more.

## What is not applied

Latency and packet loss are not injected. Applying Linux `tc` on the host could disrupt this machine, and macOS does not provide it. The API returns `ERROR` and explains that. The simulation buttons remain available for those faults.

A successful Docker command is not treated as proof. The verdict uses inspect output and probe samples.

## Safety

- Every experiment route requires a logged-in session.
- Users can read only their own rows.
- Container names must match `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`.
- Probe URLs must be plain `http` or `https`, must not contain credentials, spaces, or backslashes, must use a host in `METRICMANTIS_PROBE_ALLOWLIST`, and must not target port 3000 or 3001.
- Redirects are not followed. A 3xx response counts as a failed probe.
- Names that resolve to link-local or metadata addresses, including `169.254.169.254`, are rejected.
- HTTP probes are sent to the resolved address so a later DNS change cannot move the request.
- One experiment can run per user, and at most 8 can be created in 10 minutes.
- History keeps the latest 50 experiments per user.
- Query strings on probe URLs are removed before the request.

## Formulas

- Error rate = failed requests / total requests × 100.
- Throughput = total requests / (window seconds).
- Average latency = sum of latency samples / sample count.
- Percentiles use nearest rank: `ceil(percentile / 100 × sample count)`.
- p95 is reported only with at least 5 samples. p99 needs at least 20.
- No requests means the rate and latency are unavailable. They are not stored as zero.

## Verdicts

`PASSED` means every assertion met its threshold. `FAILED` means at least one assertion missed. `INCONCLUSIVE` means evidence was missing. `ERROR` means the run could not be executed, including disabled Docker faults. `CANCELLED` means the run was aborted.

The Smart Advisor can explain these numbers. It does not choose the verdict.

## Example configuration

This is a shape the API accepts. It is not a recorded result.

```json
{
  "mode": "measured",
  "faultType": "measure",
  "targetService": "api",
  "probeUrl": "http://127.0.0.1:8080/health",
  "baselineMs": 2000,
  "ratePerSecond": 5,
  "thresholds": { "maxErrorRatePercent": 5, "maxP95Ms": 1000 }
}
```

## Commands

```bash
cd demo/demo
npm test
cd ../../metricmantis-frontend/metricmantis-frontend
npm test
./node_modules/.bin/tsc --noEmit
```
