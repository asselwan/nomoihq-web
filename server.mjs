#!/usr/bin/env node
// NOMOI HQ research desk: landing page + free/paid gating.
// Pattern mirrors glowhum-web/server.mjs: single file, no framework, Stripe
// reached by fetch against the REST API, secret key from env only, never
// printed or logged. Delivery of the full brief stays the existing async
// process (research pipeline -> email/portal, see RESEARCH_NUKE_ARCHITECTURE.md);
// this server's job is: serve the free preview always, and prove entitlement
// before it will ever hand back the full markdown + citations for a report id.
//
// Reports are read from ./reports/<slug>.json, written by the research
// pipeline (or by hand for now). Shape:
//   { slug, title, tier_required: "standard_49"|"flagship_199",
//     cite_check_tier: "GREEN"|"AMBER"|"RED",
//     free_summary: "...", full_markdown: "...", citations: [...] }
// A RED cite_check_tier is never served in full regardless of payment,
// per the RESEARCH_HARDENING_K3_DESIGN_2026_09_01.md quarantine rule.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeOrderHandlers } from "./orders.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 80;
const HOST = process.env.HOST || "0.0.0.0";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_API_BASE_URL = process.env.STRIPE_API_BASE_URL || "https://api.stripe.com/v1";
const REPORTS_DIR = process.env.REPORTS_DIR || path.join(__dirname, "reports");
const ORDERS_DIR = process.env.ORDERS_DIR || path.join(__dirname, "orders-data");
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const orderHandlers = makeOrderHandlers(ORDERS_DIR, PUBLIC_BASE_URL);

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

async function sendFile(res, filePath, contentType) {
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}

function validSlug(slug) {
  return typeof slug === "string" && /^[a-z0-9][a-z0-9-]{0,80}$/.test(slug);
}

function validSessionId(id) {
  return typeof id === "string" && /^cs_[A-Za-z0-9_]{8,255}$/.test(id);
}

async function readRawBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body too large");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  return JSON.parse((await readRawBody(req, maxBytes)).toString("utf8"));
}

async function loadReport(slug) {
  const p = path.join(REPORTS_DIR, `${slug}.json`);
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw);
}

// Confirms a Stripe Checkout Session (created from the standard/flagship
// Payment Link) is paid AND its metadata.tier_key matches the tier this
// report requires. Payment Links created by
// nomoi-atlas/.../research-nuke-stripe-setup.ts stamp metadata.tier_key
// on both the Price and the payment_intent, so this reads the session's
// own payment_intent expansion rather than trusting the client.
async function verifyEntitlement(sessionId, requiredTierKey) {
  if (!STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY not set");
  const url = `${STRIPE_API_BASE_URL}/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` } });
  if (!response.ok) return { paid: false, reason: "session_lookup_failed" };
  const session = await response.json();
  if (session.payment_status !== "paid") return { paid: false, reason: "not_paid" };
  const intentMeta = session.payment_intent && typeof session.payment_intent === "object"
    ? session.payment_intent.metadata || {}
    : {};
  const tierKey = intentMeta.tier_key || session.metadata?.tier_key;
  if (tierKey !== requiredTierKey) return { paid: false, reason: "tier_mismatch", tier_key: tierKey || null };
  return { paid: true, tier_key: tierKey };
}

async function handleReport(req, res, slug, sessionId) {
  if (!validSlug(slug)) return sendJson(res, 400, { error: "invalid report id" });
  let report;
  try {
    report = await loadReport(slug);
  } catch {
    return sendJson(res, 404, { error: "report not found" });
  }

  const base = {
    slug: report.slug,
    title: report.title,
    cite_check_tier: report.cite_check_tier,
    free_summary: report.free_summary,
    full_available: false,
  };

  if (report.cite_check_tier === "RED") {
    // Quarantined, never delivered in full at any tier, paid or not.
    return sendJson(res, 200, { ...base, note: "This brief is quarantined pending a re-run. Full text withheld." });
  }

  if (sessionId) {
    if (!validSessionId(sessionId)) return sendJson(res, 400, { error: "invalid session id" });
    let access;
    try {
      access = await verifyEntitlement(sessionId, report.tier_required);
    } catch {
      return sendJson(res, 502, { error: "entitlement check failed, try again" });
    }
    if (access.paid) {
      return sendJson(res, 200, {
        ...base,
        full_available: true,
        full_markdown: report.full_markdown,
        citations: report.citations,
      });
    }
    return sendJson(res, 402, { ...base, error: "payment not verified for this report", detail: access.reason });
  }

  return sendJson(res, 200, base);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health") return sendJson(res, 200, { ok: true, stripe_configured: Boolean(STRIPE_SECRET_KEY) });

    const reportMatch = url.pathname.match(/^\/api\/report\/([^/]+)$/);
    if (reportMatch && req.method === "GET") {
      return handleReport(req, res, reportMatch[1], url.searchParams.get("session_id"));
    }

    if (url.pathname === "/api/checkout" && req.method === "POST") {
      return orderHandlers.handleCheckout(req, res, readJsonBody, sendJson);
    }
    if (url.pathname === "/api/stripe/webhook" && req.method === "POST") {
      return orderHandlers.handleWebhook(req, res, readRawBody, sendJson);
    }
    const orderMatch = url.pathname.match(/^\/api\/order\/([^/]+)$/);
    if (orderMatch && req.method === "GET") {
      return orderHandlers.handleOrderStatus(res, orderMatch[1], sendJson);
    }
    if (url.pathname === "/api/worker/claim" && req.method === "GET") {
      return orderHandlers.handleWorkerClaim(req, res, sendJson);
    }
    const workerReportMatch = url.pathname.match(/^\/api\/worker\/([^/]+)\/report$/);
    if (workerReportMatch && req.method === "POST") {
      return orderHandlers.handleWorkerReport(req, res, workerReportMatch[1], readJsonBody, sendJson);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return sendFile(res, path.join(__dirname, "index.html"), "text/html; charset=utf-8");
    }
    if (url.pathname === "/deliver.html") {
      return sendFile(res, path.join(__dirname, "deliver.html"), "text/html; charset=utf-8");
    }
    if (url.pathname === "/favicon.svg") {
      return sendFile(res, path.join(__dirname, "favicon.svg"), "image/svg+xml");
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (err) {
    sendJson(res, 500, { error: "internal error" });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    if (process.env.NODE_ENV !== "test") console.log(`NOMOI HQ listening on ${HOST}:${PORT}`);
  });
}

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { server, verifyEntitlement, handleReport, validSlug, validSessionId };
