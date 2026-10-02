import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DIRECTORY = "domain-health-reports";
const LIVE_PREFIX = "[Live domain health]";
const SIMULATED_PREFIX = "[SIMULATED live domain health]";

// No application imports or secrets are needed for the actual domain probe.
export function probe(simulated = null) {
  if (simulated !== null) {
    const report = {
      checkedAt: new Date().toISOString(), simulated: true, ok: simulated === "recovery",
      dns: [], checks: [], failures: simulated === "failure"
        ? [{ check: "ISOLATED TEST", message: "Simulated failure; no live domains were contacted." }] : [],
    };
    return { exitCode: report.ok ? 0 : 1, stdout: JSON.stringify(report, null, 2), stderr: "" };
  }
  const result = spawnSync("node", ["artifacts/telosora-store/scripts/check-live-domains.mjs", "--json"], {
    encoding: "utf8", timeout: 240_000, maxBuffer: 1_048_576,
  });
  return {
    exitCode: result.status ?? 2, stdout: result.stdout || "",
    stderr: `${result.stderr || ""}${result.error ? `\nRunner error: ${result.error.code || "unknown"}` : ""}`,
  };
}

export function validateResult(result) {
  try {
    const report = JSON.parse(result.stdout);
    if (!Array.isArray(report.failures) || typeof report.ok !== "boolean"
      || report.ok !== (result.exitCode === 0) || (report.ok && report.failures.length)) {
      throw new Error("Inconsistent checker result");
    }
    return report;
  } catch {
    return {
      checkedAt: new Date().toISOString(), ok: false, runnerError: true,
      failures: [{ check: "Monitor runner", message: "Checker report missing, malformed, or inconsistent; inspect retained stdout/stderr." }],
    };
  }
}

export async function github(path, options = {}) {
  const repository = process.env.GH_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "") || !process.env.GH_TOKEN) {
    throw new Error("Missing GitHub runner configuration");
  }
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub ${options.method || "GET"} ${path} failed (${response.status})`);
  return response.json();
}

export async function openIncidents(api, prefix) {
  const matches = [];
  for (let page = 1; ; page++) {
    const issues = await api(`/issues?state=open&per_page=100&page=${page}`);
    matches.push(...issues.filter(issue => !issue.pull_request && issue.title.startsWith(`${prefix} Incident `)
      && issue.body?.includes("<!-- telosora-domain-monitor -->")));
    if (issues.length < 100) break;
  }
  return matches;
}

// Save reports to the issue before sending, and close only after recovery delivery.
// GitHub issue history is durable; artifact retention never deletes incident reports.
export async function handleResult({ result, api = github, notify, simulated = false, runUrl, save }) {
  const report = validateResult(result);
  const prefix = simulated ? SIMULATED_PREFIX : LIVE_PREFIX;
  await save({ ...result, report });
  const incidents = await openIncidents(api, prefix);
  const evidence = [
    `${simulated ? "**ISOLATED SIMULATION: not a live outage.**\n" : ""}Checked at ${report.checkedAt}`,
    `Runner: ${runUrl}`, `Original checker exit code: ${result.exitCode}`,
    "```json", JSON.stringify(report, null, 2), "```",
    result.stderr ? `Stderr:\n\`\`\`\n${result.stderr.slice(0, 8000)}\n\`\`\`` : "",
  ].join("\n\n");
  if (!report.ok) {
    let incident = incidents[0];
    if (incident) {
      await api(`/issues/${incident.number}/comments`, { method: "POST", body: { body: evidence } });
    } else {
      incident = await api("/issues", { method: "POST", body: {
        title: `${prefix} Incident ${report.checkedAt}`,
        body: `<!-- telosora-domain-monitor -->\n${evidence}`,
      } });
    }
    try {
      await notify(`${prefix} ${report.runnerError ? "RUNNER ERROR" : "FAILURE"}`,
        `${evidence}\n\nIncident history: ${incident.html_url}\nNo automatic checker retry was performed.`);
      await api(`/issues/${incident.number}/comments`, { method: "POST", body: {
        body: `Failure email accepted by SMTP for this run: ${runUrl}`,
      } });
    } catch (error) {
      await api(`/issues/${incident.number}/comments`, { method: "POST", body: {
        body: `Failure notification was not confirmed for ${runUrl}. Original failure remains above. Inspect the workflow; delivery may be ambiguous.`,
      } });
      throw error;
    }
    return 1;
  }
  for (const incident of incidents) {
    // Include original failure evidence even if its notification failed.
    const message = `${evidence}\n\nRecovered from the earlier failure recorded below:\n\n${incident.body}\n\n`
      + `Complete failure history: ${incident.html_url}\nPrevious failures and reports have not been removed.`;
    await notify(`${prefix} RECOVERY`, message);
    await api(`/issues/${incident.number}/comments`, { method: "POST", body: {
      body: `${evidence}\n\nRecovery email accepted by SMTP. Closing without deleting earlier failures.`,
    } });
    await api(`/issues/${incident.number}`, { method: "PATCH", body: { state: "closed", state_reason: "completed" } });
  }
  return 0;
}

async function notify(subject, body) {
  const messageFile = `${DIRECTORY}/notification.txt`;
  await writeFile(messageFile, body);
  const result = spawnSync("python3", ["artifacts/telosora-store/scripts/external-monitor/send-email.py"], {
    encoding: "utf8", timeout: 90_000,
    env: { ...process.env, ALERT_SUBJECT: subject, ALERT_MESSAGE_FILE: messageFile },
  });
  // The Python sender prints only safe status messages, never SMTP responses.
  if (result.stdout) console.log(result.stdout.trim());
  if (result.stderr) console.error(result.stderr.trim());
  if (result.status !== 0) throw new Error("Email delivery was not confirmed; see retained incident and workflow.");
}

export async function main() {
  await mkdir(DIRECTORY, { recursive: true });
  const missing = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD",
    "SMTP_FROM", "ALERT_TO"].filter(key => !process.env[key]);
  if (missing.length) {
    const message = `Monitoring is not ready: configure GitHub Actions secrets/settings for ${missing.join(", ")}.`;
    await writeFile(`${DIRECTORY}/configuration-error.txt`, message);
    throw new Error(message);
  }
  const simulated = process.env.SIMULATE === "true";
  const runUrl = process.env.MONITOR_RUN_URL;
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(runUrl || "")) {
    throw new Error("Missing or invalid workflow run URL");
  }
  const modes = simulated ? ["failure", "recovery"] : [null];
  for (const mode of modes) {
    const code = await handleResult({
      result: probe(mode), simulated, runUrl, notify,
      save: async data => {
        const stem = `${DIRECTORY}/${mode || "live"}`;
        await Promise.all([
          writeFile(`${stem}.stdout.json`, data.stdout),
          writeFile(`${stem}.stderr.log`, data.stderr),
          writeFile(`${stem}.exit-code.txt`, String(data.exitCode)),
          writeFile(`${stem}.report.json`, JSON.stringify(data.report, null, 2)),
        ]);
        await writeFile(`${DIRECTORY}/run.json`, JSON.stringify({ runUrl, simulated }, null, 2));
      },
    });
    // The simulated failure is expected, but only continue after its email succeeds.
    if (!simulated && code !== 0) return code;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}