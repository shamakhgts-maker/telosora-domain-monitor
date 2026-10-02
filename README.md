# Telosora external domain monitor

This independent repository contains only the read-only public-domain checker,
its notification runner, and this guide. It does not contain the website or
application secrets. Never add the application's environment, credentials,
databases, private routes, or deployment configuration.

## Setup

In **Settings → Secrets and variables → Actions**, add repository secrets:

| Secret | Purpose |
| --- | --- |
| `SMTP_HOST` | Your existing email provider's SMTP hostname |
| `SMTP_PORT` | Usually `465` for implicit TLS or `587` for STARTTLS |
| `SMTP_SECURE` | `true` for implicit TLS; `false` for STARTTLS (TLS is still mandatory) |
| `SMTP_USER` | Account authorized to send monitor emails |
| `SMTP_PASSWORD` | Provider-approved SMTP password or app password |
| `SMTP_FROM` | Sender address authorized by the provider |

The destination approved by the owner is set in the workflow's `ALERT_TO`.
Never put credentials in a commit, issue, workflow input, or chat. Secrets in
another service are not automatically available to GitHub Actions.

The workflow must have **read contents / write issues** permissions. Enable
Actions if disabled. Do not change the website's deployment to run this monitor.
Use GitHub's standard `ubuntu-latest` runner, Node 22, Python 3, and trusted
system certificates. The runner needs outbound DNS to `1.1.1.1` and `8.8.8.8`
and outbound TCP 80/443. SMTP access must also be allowed by the provider.
Do not bypass DNS or TLS checks to force a passing result.

## Commissioning

1. Enter the SMTP secrets before enabling or installing the workflow.
   If the integration cannot install workflows, open `workflow-template.txt`
   in GitHub's editor and change its filename to
   `.github/workflows/live-domain-health.yml`, then commit to `main`.
   GitHub activates the schedule when the workflow is installed on `main`.
2. If disabled, enable it. Open **Actions → Live domain health → Run workflow**, and select
   **simulate**. This sends clearly marked simulated failure and recovery
   messages without making any requests to the live domains. It creates a
   separate simulated incident and closes it only after recovery email delivery.
3. Verify both emails reached the destination. SMTP acceptance is not proof of
   inbox delivery. If the workflow fails, inspect its logs and retained artifact.
4. Manually run again with **simulate unchecked**. Inspect the genuine report.
5. Confirm the schedule is enabled and a subsequent scheduled run occurred.

## Operation and evidence

The workflow runs at minutes **7, 22, 37, 52** each hour (UTC). This is nominally
every 15 minutes, but GitHub schedules can be delayed or dropped and are not an
exact uptime SLA. Public-repository inactivity may disable schedules after
60 days; check GitHub's current policies and re-enable when required.
GitHub's standard hosted runners are free for public repositories, subject to
GitHub's current policies. Do not enable paid/larger runners.

The exact live command is:

```sh
node artifacts/telosora-store/scripts/check-live-domains.mjs --json
```

Exit **1** remains a failed workflow after sending the alert. Unexpected runner
errors are separately labeled and fail explicitly. Runs never overlap
(`cancel-in-progress: false`); GitHub may replace an older pending run when
several are queued.

Each run preserves original stdout, stderr, exit code, parsed report, and
notification text in a uniquely named artifact for **90 days**. Failures are
also appended to a GitHub incident issue **before** an email is attempted.
These public issues retain the JSON report independently of artifact expiration.
Never put private application data in these reports.

Every failing check sends an email. Healthy runs send no routine email; the
first healthy run after an open incident sends a recovery email linking to
and quoting the original failure. The incident is closed, never deleted, only
after SMTP accepts recovery. Earlier failures remain in the issue history.
Simulation uses a separate incident prefix and cannot close a live incident.

There are no automatic checker retries that could replace the original failure
with a pass. SMTP failures are explicit, and no immediate SMTP retry is made
because delivery may be ambiguous. An unresolved incident stays open; subsequent
runs may send another failure or retry recovery, with all original evidence kept.
If GitHub is down, workflows cannot run or preserve issues; this is not a
second independent dead-man monitor.

## Updating the checker

Copy only monitoring files from the Telosora project. Preserve the original
checker and review changes before committing them. The standalone monitor
does not auto-sync or redeploy the website. Offline regression commands:

```sh
node --test artifacts/telosora-store/test/live-domain-health.test.mjs \
  artifacts/telosora-store/test/domain-monitor.test.mjs
```