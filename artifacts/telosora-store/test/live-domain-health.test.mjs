import test from "node:test";
import assert from "node:assert/strict";
import { certificateDetails, checkChain, runHealthCheck } from "../scripts/check-live-domains.mjs";

const certificate = { host: "telosora.com", daysRemaining: 30 };
const ok = { status: 200, certificate };
const start = "https://www.telosora.com/digital/sitetoy?value=a%2Fb&tag=one&tag=two&empty=";
const apex = start.replace("www.", "");
const redirect = (location, status = 308) => ({ status, location, certificate });

test("allows direct apex and permanent HTTP/HTTPS www redirects preserving exact path/query", async () => {
  for (const status of [301, 308]) {
    for (const url of [start, start.replace("https:", "http:")]) {
      const result = await checkChain(url, async (current) => current.hostname.startsWith("www.")
        ? redirect(apex, status) : ok);
      assert.equal(result.finalUrl, apex);
      assert.equal(result.redirects, 1);
    }
  }
  assert.equal((await checkChain(apex, async () => ok)).redirects, 0);
});

test("allows bounded permanent HTTP upgrade followed by apex redirect", async () => {
  const responses = [redirect(start, 301), redirect(apex), ok];
  assert.equal((await checkChain(start.replace("https:", "http:"), async () => responses.shift())).redirects, 2);
});

test("rejects temporary redirects, missing Location, changed path or query and unsafe destinations", async () => {
  for (const [response, message] of [
    [redirect(apex, 302), /Non-permanent/],
    [redirect(apex, 307), /Non-permanent/],
    [redirect(undefined), /Missing Location/],
    [redirect("https://telosora.com/"), /Path\/query changed/],
    [redirect(apex.replace("a%2Fb", "a/b")), /Path\/query changed/],
    [redirect(apex.replace("&tag=two", "")), /Path\/query changed/],
    [redirect(apex.replace("telosora.com", "evil.example")), /Unexpected redirect/],
    [redirect(apex.replace("https:", "http:")), /does not use HTTPS/],
    [redirect(`${apex}#fragment`), /Unexpected redirect/],
    [redirect(apex.replace("telosora.com", "telosora.com:444")), /Unexpected redirect/],
    [redirect(apex.replace("telosora.com", "user@telosora.com")), /Unexpected redirect/],
  ]) {
    await assert.rejects(checkChain(start, async () => response), message);
  }
});

test("rejects loops, excessive redirects, non-apex termination, non-200 and missing TLS checks", async () => {
  await assert.rejects(checkChain(start, async () => redirect(start)), /Redirect loop/);
  await assert.rejects(checkChain(start, async () => redirect(apex), 0), /Exceeded 0/);
  await assert.rejects(checkChain(start, async () => ok), /canonical apex/);
  await assert.rejects(checkChain(apex, async () => ({ ...ok, status: 503 })), /got 503/);
  await assert.rejects(checkChain(apex, async () => ({ status: 200 })), /Missing trusted TLS/);
  await assert.rejects(checkChain(apex, async () => { throw new Error("Request timed out"); }), /timed out/);
});

test("certificate validation rejects untrusted, mismatched and expired certificates", () => {
  const now = Date.parse("2026-10-02T00:00:00.000Z");
  const cert = {
    subjectaltname: "DNS:telosora.com",
    valid_from: new Date(now - 86_400_000).toUTCString(),
    valid_to: new Date(now + 30 * 86_400_000).toUTCString(),
  };
  const socket = { authorized: true, getPeerCertificate: () => cert };
  assert.equal(certificateDetails(socket, "telosora.com", now).daysRemaining, 30);
  assert.throws(() => certificateDetails({ ...socket, authorized: false }, "telosora.com", now), /untrusted/);
  assert.throws(() => certificateDetails(socket, "www.telosora.com", now), /altnames/);
  assert.throws(() => certificateDetails(socket, "telosora.com", now + 31 * 86_400_000), /validity/);
  assert.throws(() => certificateDetails(socket, "telosora.com", now - 2 * 86_400_000), /validity/);
});

test("aggregates DNS/network failures instead of hiding them or stopping at the first failure", async () => {
  const report = await runHealthCheck({
    resolveDns: async () => { throw new Error("DNS timeout"); },
    request: async () => { throw new Error("TLS handshake failed"); },
  });
  assert.equal(report.ok, false);
  assert.equal(report.failures.length, 10);
  assert.equal(report.checks.length, 0);
});

test("healthy report contains both public resolvers and all six probes", async () => {
  const report = await runHealthCheck({
    resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (url) => url.hostname.startsWith("www.")
      ? redirect(url.href.replace("http:", "https:").replace("www.", "")) : ok,
  });
  assert.equal(report.ok, true);
  assert.equal(report.dns.length, 4);
  assert.equal(report.checks.length, 6);
});