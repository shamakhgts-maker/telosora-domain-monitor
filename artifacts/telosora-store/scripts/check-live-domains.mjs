#!/usr/bin/env node
// Read-only public-network probe. No app imports, credentials, or writes.
import { Resolver } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

export const ORIGINS = [
  "http://www.telosora.com",
  "https://www.telosora.com",
  "https://telosora.com",
];
export const TARGETS = [
  "/",
  "/digital/sitetoy?source=live%20check&value=a%2Fb&tag=one&tag=two&empty=",
];
const HOSTS = ["telosora.com", "www.telosora.com"];
const DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export async function resolvePublicDns(host, server) {
  const resolver = new Resolver({ timeout: 3_000, tries: 1 });
  resolver.setServers([server]);
  const answers = await Promise.all([4, 6].map(async (family) => {
    try {
      const addresses = await resolver[family === 4 ? "resolve4" : "resolve6"](host);
      return addresses.map((address) => ({ address, family }));
    } catch (error) {
      // An absent address family is fine, but NXDOMAIN/timeouts/SERVFAIL are not.
      if (error.code === "ENODATA") return [];
      throw new Error(`${host} via ${server} IPv${family}: ${error.code || error.message}`);
    }
  }));
  const addresses = answers.flat();
  if (!addresses.length) throw new Error(`${host} via ${server}: no A or AAAA records`);
  return addresses;
}

export function certificateDetails(socket, host, now = Date.now()) {
  if (!socket.authorized) throw new Error(`TLS ${host}: ${socket.authorizationError || "untrusted certificate"}`);
  const cert = socket.getPeerCertificate();
  const identityError = tls.checkServerIdentity(host, cert);
  if (identityError) throw identityError;
  const validFrom = Date.parse(cert.valid_from);
  const validTo = Date.parse(cert.valid_to);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || now < validFrom || now >= validTo) {
    throw new Error(`TLS ${host}: invalid certificate validity dates`);
  }
  return {
    host, subjectAltName: cert.subjectaltname,
    expiresAt: new Date(validTo).toISOString(),
    daysRemaining: Math.floor((validTo - now) / 86_400_000),
  };
}

export function requestHeaders(url, addresses) {
  return new Promise((resolve, reject) => {
    const address = addresses.get(url.hostname)?.[0];
    if (!address) return reject(new Error(`No checked DNS address for ${url.hostname}`));
    let certificate;
    let timer;
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(url, {
      method: "GET",
      agent: false,
      // Pin transport to an address from public DNS; keep URL Host and SNI intact.
      lookup: (_host, options, callback) => options.all
        ? callback(null, [address])
        : callback(null, address.address, address.family),
      servername: url.hostname,
      rejectUnauthorized: true,
      headers: { "User-Agent": "Telosora-Live-Domain-Check/1.0", Accept: "text/html" },
    }, (response) => {
      clearTimeout(timer);
      const result = { status: response.statusCode, location: response.headers.location, certificate };
      // Only headers are needed; don't download the application or load assets.
      response.destroy();
      resolve(result);
    });
    req.on("socket", (socket) => {
      if (url.protocol === "https:") {
        socket.once("secureConnect", () => {
          try {
            certificate = certificateDetails(socket, url.hostname);
          } catch (error) {
            req.destroy(error);
          }
        });
      }
    });
    req.once("error", (error) => { clearTimeout(timer); reject(error); });
    // Wall-clock deadline includes DNS/connect/handshake/response headers.
    timer = setTimeout(() => req.destroy(new Error(`Request timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    req.end();
  });
}

export async function checkChain(start, request, maxRedirects = MAX_REDIRECTS) {
  let current = new URL(start);
  const expected = new URL(`${current.pathname}${current.search}`, "https://telosora.com");
  const steps = [];
  const visited = new Set();
  for (;;) {
    if (visited.has(current.href)) throw new Error(`Redirect loop at ${current.href}`);
    visited.add(current.href);
    const result = await request(current);
    steps.push({ url: current.href, ...result });
    if (current.protocol === "https:" && !result.certificate) {
      throw new Error(`Missing trusted TLS verification for ${current.hostname}`);
    }
    if (result.status >= 300 && result.status < 400) {
      if (![301, 308].includes(result.status)) throw new Error(`Non-permanent redirect ${result.status} at ${current.href}`);
      if (!result.location) throw new Error(`Missing Location at ${current.href}`);
      if (steps.length > maxRedirects) throw new Error(`Exceeded ${maxRedirects} redirects`);
      const next = new URL(result.location, current);
      if (!HOSTS.includes(next.hostname) || next.port || next.username || next.password || next.hash) {
        throw new Error(`Unexpected redirect destination: ${next.href}`);
      }
      if (next.protocol !== "https:") throw new Error(`Redirect does not use HTTPS: ${next.href}`);
      if (next.pathname !== expected.pathname || next.search !== expected.search) {
        throw new Error(`Path/query changed: ${current.href} -> ${next.href}`);
      }
      current = next;
      continue;
    }
    if (current.href !== expected.href) throw new Error(`Did not reach canonical apex: ${current.href}`);
    if (result.status !== 200) throw new Error(`Expected 200 at ${current.href}, got ${result.status}`);
    return { start, finalUrl: current.href, redirects: steps.length - 1, steps };
  }
}

export async function runHealthCheck({ resolveDns = resolvePublicDns, request = requestHeaders } = {}) {
  const report = { checkedAt: new Date().toISOString(), ok: true, dns: [], checks: [], failures: [] };
  const addresses = new Map();
  for (const host of HOSTS) {
    for (const server of DNS_SERVERS) {
      try {
        const records = await resolveDns(host, server);
        report.dns.push({ host, server, records });
        // Prefer IPv4 for runners without outbound IPv6. This is not an all-IP audit.
        if (!addresses.has(host)) addresses.set(host, [...records].sort((a, b) => a.family - b.family));
      } catch (error) {
        report.failures.push({ check: `DNS ${host} via ${server}`, message: error.message });
      }
    }
  }
  for (const origin of ORIGINS) {
    for (const target of TARGETS) {
      const start = `${origin}${target}`;
      try {
        report.checks.push(await checkChain(start, (url) => request(url, addresses)));
      } catch (error) {
        report.failures.push({ check: start, message: `${error.code ? `${error.code}: ` : ""}${error.message}` });
      }
    }
  }
  report.ok = report.failures.length === 0;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some((arg) => !["--json", "--help"].includes(arg))) {
    console.error("Usage: node scripts/check-live-domains.mjs [--json | --help]");
    process.exitCode = 2;
  } else if (process.argv.includes("--help")) {
    console.log("Read-only public DNS, trusted TLS and canonical redirect checks. Exit 0 = healthy, 1 = failed, 2 = bad arguments. --json emits a machine-readable report.");
  } else {
    const report = await runHealthCheck();
    if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Live domain check ${report.checkedAt}: ${report.ok ? "PASS" : "FAIL"}`);
      for (const dns of report.dns) console.log(`DNS ${dns.host} via ${dns.server}: ${dns.records.map((r) => r.address).join(", ")}`);
      for (const check of report.checks) {
        console.log(`PASS ${check.start} -> ${check.finalUrl} (${check.redirects} redirects)`);
        for (const step of check.steps) {
          console.log(`  ${step.status} ${step.url}${step.location ? ` -> ${step.location}` : ""}`);
          if (step.certificate) console.log(`  TLS trusted, hostname covered; expires ${step.certificate.expiresAt} (${step.certificate.daysRemaining} days)`);
        }
      }
      for (const failure of report.failures) console.error(`FAIL ${failure.check}: ${failure.message}`);
    }
    process.exitCode = report.ok ? 0 : 1;
  }
}