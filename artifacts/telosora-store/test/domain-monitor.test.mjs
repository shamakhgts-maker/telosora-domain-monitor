import test from "node:test";
import assert from "node:assert/strict";
import { handleResult, probe, validateResult } from "../scripts/external-monitor/run-monitor.mjs";

function harness({ failEmail = false } = {}) {
  const issues = [];
  const comments = [];
  const emails = [];
  const saved = [];
  const api = async (path, options = {}) => {
    if (path.startsWith("/issues?")) return issues.filter(issue => issue.state === "open");
    if (path === "/issues") {
      const issue = { ...options.body, number: issues.length + 1, state: "open", html_url: "https://github.com/example/monitor/issues/1" };
      issues.push(issue);
      return issue;
    }
    if (path.endsWith("/comments")) { comments.push(options.body.body); return {}; }
    const issue = issues.find(issue => path === `/issues/${issue.number}`);
    Object.assign(issue, options.body);
    return issue;
  };
  return {
    issues, comments, emails, saved,
    run: (result, simulated = false) => handleResult({
      result, simulated, api, runUrl: "https://github.com/example/monitor/actions/runs/1",
      save: async data => saved.push(data),
      notify: async (subject, body) => {
        if (failEmail) throw new Error("SMTP unavailable");
        emails.push({ subject, body });
      },
    }),
  };
}

test("exit 1 alerts, retains repeated failures, and later recovery closes without erasing evidence", async () => {
  const h = harness();
  assert.equal(await h.run(probe("failure")), 1);
  const original = h.issues[0].body;
  assert.equal(await h.run(probe("failure")), 1);
  assert.equal(h.issues.length, 1);
  assert.equal(await h.run(probe("recovery")), 0);
  assert.deepEqual(h.emails.map(e => e.subject.split(" ").at(-1)), ["FAILURE", "FAILURE", "RECOVERY"]);
  assert.equal(h.issues[0].state, "closed");
  assert.equal(h.issues[0].body, original);
  assert.ok(h.emails[2].body.includes(original));
  assert.equal(h.saved.length, 3);
  assert.ok(h.comments.some(c => c.includes("Original checker exit code: 1")));
});

test("healthy first run sends nothing and creates no incident", async () => {
  const h = harness();
  assert.equal(await h.run(probe("recovery")), 0);
  assert.equal(h.emails.length, 0);
  assert.equal(h.issues.length, 0);
});

test("simulation cannot close a real incident", async () => {
  const h = harness();
  await h.run(probe("failure"));
  await h.run(probe("failure"), true);
  await h.run(probe("recovery"), true);
  assert.equal(h.issues[0].state, "open");
  assert.equal(h.issues[1].state, "closed");
  assert.match(h.emails[1].subject, /SIMULATED/);
});

test("failed email is explicit and leaves original failure and open incident intact", async () => {
  const h = harness({ failEmail: true });
  await assert.rejects(h.run(probe("failure")), /SMTP unavailable/);
  assert.equal(h.issues[0].state, "open");
  assert.match(h.issues[0].body, /Simulated failure/);
  await assert.rejects(h.run(probe("recovery")), /SMTP unavailable/);
  assert.equal(h.issues[0].state, "open");
});

test("malformed output and inconsistent exit status are runner failures, not silent recoveries", async () => {
  const h = harness();
  for (const result of [
    { exitCode: 2, stdout: "", stderr: "Timed out" },
    { ...probe("recovery"), exitCode: 1 },
    { ...probe("failure"), exitCode: 0 },
  ]) {
    assert.equal(validateResult(result).ok, false);
    assert.equal(await h.run(result), 1);
  }
  assert.ok(h.emails.every(e => e.subject.endsWith("RUNNER ERROR")));
  assert.ok(h.saved[0].stderr.includes("Timed out"));
});