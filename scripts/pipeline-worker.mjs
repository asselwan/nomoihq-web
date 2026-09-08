#!/usr/bin/env node
// NOMOI HQ pipeline worker. Runs where .tools/research actually works (ssh
// access to aule, provider credentials), not inside the nomoihq-web
// container, which never holds those keys. Polls the deployed server's
// bearer-token worker endpoints, runs the paid research pipeline for each
// claimed order, and posts the result back. A RED/INCONCLUSIVE/FAILED tier
// is reported as-is; the server refunds it, this script never decides that.
//
// Usage: node pipeline-worker.mjs [--once]
// Env: RESEARCH_SERVER_URL, RESEARCH_WORKER_TOKEN (must match server),
//      RESEARCH_PIPELINE_CMD (default /home/ainur/Apps/.tools/research),
//      RESEARCH_PIPELINE_OUTPUT_ROOT (default /home/ainur/Apps/nomoihq-web/orders-data/pipeline),
//      RESEARCH_POLL_MS (default 30000)

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { findBriefDir, buildReportFromBriefDir } from "../report-build.mjs";

const SERVER_URL = (process.env.RESEARCH_SERVER_URL || "http://127.0.0.1:80").replace(/\/$/, "");
const WORKER_TOKEN = process.env.RESEARCH_WORKER_TOKEN || "";
const PIPELINE_CMD = process.env.RESEARCH_PIPELINE_CMD || "/home/ainur/Apps/.tools/research";
const OUTPUT_ROOT = process.env.RESEARCH_PIPELINE_OUTPUT_ROOT || "/home/ainur/Apps/nomoihq-web/orders-data/pipeline";
const POLL_MS = Number(process.env.RESEARCH_POLL_MS) || 30000;
const PIPELINE_TIER_BY_KEY = { standard_49: "cheap", flagship_199: "flagship" };

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${WORKER_TOKEN}`, "Content-Type": "application/json", ...extra };
}

async function claimOne() {
  const response = await fetch(`${SERVER_URL}/api/worker/claim`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`claim failed: HTTP ${response.status}`);
  return response.json();
}

function runPipeline(question, tierKey, outputRoot) {
  return new Promise((resolve) => {
    const pipelineTier = PIPELINE_TIER_BY_KEY[tierKey] || "cheap";
    const child = spawn(PIPELINE_CMD, [question, "--tier", pipelineTier], {
      env: { ...process.env, RESEARCH_OUTPUT_ROOT: outputRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stderr }));
    child.on("error", (error) => resolve({ code: 1, stderr: String(error) }));
  });
}

async function reportBack(sessionId, claim, payload) {
  const response = await fetch(`${SERVER_URL}/api/worker/${sessionId}/report`, {
    method: "POST",
    headers: authHeaders({ "x-worker-claim": claim }),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`report failed: HTTP ${response.status}`);
  return response.json();
}

async function processOne() {
  const claimed = await claimOne();
  if (!claimed.claimed) return false;
  const { session_id: sessionId, question, tier_key: tierKey, claim } = claimed;
  console.log(`[pipeline-worker] claimed ${sessionId} tier=${tierKey}`);
  const outputRoot = path.join(OUTPUT_ROOT, sessionId);
  await fs.mkdir(outputRoot, { recursive: true });
  const run = await runPipeline(question, tierKey, outputRoot);
  const briefDir = await findBriefDir(outputRoot);
  let report;
  if (!briefDir) {
    report = { cite_check_tier: "FAILED", reason: `no brief directory produced (exit ${run.code})`, stderr_tail: run.stderr.slice(-500) };
  } else {
    report = await buildReportFromBriefDir(briefDir);
  }
  console.log(`[pipeline-worker] ${sessionId} cite_check_tier=${report.cite_check_tier}`);
  await reportBack(sessionId, claim, report);
  return true;
}

async function main() {
  const once = process.argv.includes("--once");
  if (!WORKER_TOKEN) {
    console.error("[pipeline-worker] RESEARCH_WORKER_TOKEN not set, refusing to start");
    process.exit(1);
  }
  for (;;) {
    let worked = false;
    try {
      worked = await processOne();
    } catch (error) {
      console.error(`[pipeline-worker] error: ${error.message}`);
    }
    if (once) return;
    if (!worked) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

main();
