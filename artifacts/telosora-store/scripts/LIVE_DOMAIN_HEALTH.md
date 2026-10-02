# Live domain health check

Run from the repository root (Node.js 22+; no packages or credentials needed):

```sh
node artifacts/telosora-store/scripts/check-live-domains.mjs
# Machine-readable report, same exit status:
node artifacts/telosora-store/scripts/check-live-domains.mjs --json
# Offline regression tests, no network:
node --test artifacts/telosora-store/test/live-domain-health.test.mjs
```

Exit codes: **0** healthy, **1** DNS/TLS/HTTP/redirect failure, **2** invalid arguments.
Reports include a UTC timestamp, DNS answers, each successful redirect chain,
certificate hostname coverage and expiration, and individual failures.

## What it checks

- `http://www.telosora.com/`, `https://www.telosora.com/`, and
  `https://telosora.com/`, plus a second probe for each origin at
  `/digital/sitetoy?source=live%20check&value=a%2Fb&tag=one&tag=two&empty=`.
- Public A/AAAA resolution through **both Cloudflare (1.1.1.1) and Google
  (8.8.8.8)**. Missing one address family is allowed; DNS errors, resolver
  timeouts, or no addresses fail. A blocked public resolver also fails rather
  than silently falling back to local DNS.
- HTTPS uses Node's trusted certificate authorities with certificate validation
  enabled, the actual hostname for SNI, and an explicit hostname/date check.
  HTTPS `www` must have its own valid hostname coverage before it can redirect.
  Certificate expiration is reported, not treated as an early-expiry alert.
- Every redirect must be **301 or 308**, remain on the two approved hostnames,
  use HTTPS, and preserve the exact encoded path and query (including order,
  duplicate parameters and empty values). Credentials, nonstandard ports and
  fragments are rejected. Loops fail; at most **three redirects** are allowed.
- Every chain must finish at the matching `https://telosora.com` URL with **200**.
  A redirect to a login page, temporary redirect, or HTTP downgrade is a failure.

Requests are GETs, only response headers are consumed, and no browser assets,
private routes, inquiry submissions, authentication, database access or writes
are involved. The script does not edit registrar records, launch/indexing
settings, deployment configuration, or databases. No secrets are used.

Each DNS query has a three-second timeout with one attempt; each HTTP hop has
a ten-second wall-clock deadline. Failures are aggregated into one report.
Transport uses the first successful resolver's address, preferring IPv4 so it
can run on hosts without outbound IPv6. It does **not** test every returned IP,
every geographic edge, or IPv6 connectivity when IPv4 exists. Run from an
independent external host for a visitor-like view. Do not disable TLS
verification or install an untrusted CA to make a failed check pass.

## External scheduling

The owner approved a public, monitor-only GitHub repository:
<https://github.com/shamakhgts-maker/telosora-domain-monitor>. It contains
monitoring code only, not the website or its secrets. The workflow template and
notification runner are maintained in `scripts/external-monitor/`; see its
README for SMTP setup, isolated simulation, report retention, and commissioning.

The GitHub connection accepted ordinary repository files but could not install
the workflow. Until the owner installs `workflow-template.txt` as
`.github/workflows/live-domain-health.yml`, adds the SMTP Actions secrets, and
the isolated notification test succeeds, **automatic monitoring is not active**.
Do not treat a prepared workflow or a passing local test as proof of scheduling
or notification delivery.

The GitHub schedule requests minutes 7, 22, 37, 52 of every UTC hour; GitHub may
delay or drop scheduled jobs. A runner's public DNS restrictions must be
reported, not bypassed. Failure stdout/stderr and exit status are retained in
90-day run artifacts and failure JSON is recorded in durable GitHub issue
history before notification. Recovery closes the incident only after SMTP
acceptance and never removes the original failure.

Use an existing external scheduler/CI runner with Node.js, a trusted system CA
store, outbound DNS to the two resolvers, and outbound TCP ports 80/443. Run
every 15 minutes, capture stdout/stderr and the exit code, and notify the owner
on nonzero exit. A schedule without failure notifications does not provide
early warning. For example, on an independent Linux host with cron:

```cron
*/15 * * * * cd /absolute/path/to/checkout && /absolute/path/to/node artifacts/telosora-store/scripts/check-live-domains.mjs >> /absolute/path/to/domain-health.log 2>&1
```

Replace the paths; ensure the scheduler actually alerts on exit **1** (plain
cron with log redirection does not). Configure log retention and avoid
overlapping runs. For CI, execute the same command without suppressing its exit
code, and enable failed-job notifications. No production redeploy is necessary;
do not replace the website's deployment with a scheduled job.

## Investigating failures

Distinguish runner DNS/network restrictions from failures seen from a second
independent network. Inspect the failing hostname, chain hop and certificate
error. Do not automatically retry ambiguous failures into a passing result:
retain the original failure and let the next scheduled run show recovery.
The existing route-readiness and HTTP-security tests still cover application
Host handling; they cannot verify public DNS or external certificates.

Deployment metadata inspected during implementation on 2026-10-02 reported a
public autoscale deployment with a successful build, primary URL
`https://telosora.com`, and additional URLs `https://www.telosora.com` and
`https://telosora-digital-store.replit.app`. This snapshot is not a health signal;
the script checks the live custom domains directly on every run.