// Turns a finished .tools/research brief directory into the customer-facing
// report shape the order flow delivers: a plain verdict, the findings with
// their sources, and the cite-check tier that gates delivery. Reads only
// what the pipeline already wrote (TECHNICAL_HANDOVER.md, citecheck.json);
// invents no new claims. NOMOI-internal sections ("What this means for
// NOMOI", "Downstream execution") never ship to a buyer.

import fs from "node:fs/promises";
import path from "node:path";

const CUSTOMER_SECTIONS = ["Findings", "Recommendation", "Best-answer tradeoffs", "Open questions"];

function extractSection(markdown, heading) {
  const lines = markdown.split("\n");
  const wanted = heading.trim().toLowerCase();
  let capturing = false;
  const collected = [];
  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      if (capturing) break;
      capturing = headingMatch[1].trim().toLowerCase() === wanted;
      continue;
    }
    if (capturing) collected.push(line);
  }
  return collected.join("\n").trim();
}

function extractFindingBullets(findingsSection) {
  return findingsSection
    .split(/\n(?=\*\s|-\s|\d+\.\s)/)
    .map((row) => row.trim())
    .filter(Boolean);
}

function citationsFromClaims(claims) {
  const seen = new Map();
  for (const claim of claims || []) {
    const url = claim.source_url;
    if (!url || typeof url !== "string") continue;
    if (seen.has(url)) continue;
    let title = url;
    try {
      title = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      // keep raw url as title if it does not parse
    }
    seen.set(url, { url, title, status: claim.status || "UNVERIFIED" });
  }
  return [...seen.values()];
}

// Finds the single brief directory .tools/research wrote under root (the
// caller scopes root to one order, e.g. <ordersDir>/pipeline/<session_id>,
// so there is exactly one subdirectory once the run completes).
export async function findBriefDir(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((entry) => entry.isDirectory());
  if (dirs.length !== 1) return null;
  return path.join(root, dirs[0].name);
}

export async function buildReportFromBriefDir(briefDir) {
  const handoverPath = path.join(briefDir, "TECHNICAL_HANDOVER.md");
  const citecheckPath = path.join(briefDir, "citecheck.json");
  const handover = await fs.readFile(handoverPath, "utf8").catch(() => "");
  const citecheckRaw = await fs.readFile(citecheckPath, "utf8").catch(() => null);
  if (!handover || !citecheckRaw) return { cite_check_tier: "FAILED", reason: "pipeline_output_missing" };

  let citecheck;
  try {
    citecheck = JSON.parse(citecheckRaw);
  } catch {
    return { cite_check_tier: "FAILED", reason: "citecheck_malformed" };
  }

  const tier = typeof citecheck.tier === "string" ? citecheck.tier : "FAILED";
  const citations = citationsFromClaims(citecheck.claims);
  const findings = extractFindingBullets(extractSection(handover, "Findings"));
  if (!findings.length) return { cite_check_tier: "FAILED", reason: "no_findings_extracted" };

  const bodyParts = [];
  bodyParts.push("## Findings\n\n" + findings.join("\n"));
  for (const heading of ["Recommendation", "Best-answer tradeoffs"]) {
    const section = extractSection(handover, heading);
    if (section) bodyParts.push(`## ${heading}\n\n${section}`);
  }
  if (citations.length) {
    bodyParts.push("## Sources\n\n" + citations.map((c) => `- ${c.title} (${c.status.toLowerCase()}), source: ${c.url}`).join("\n"));
  }
  bodyParts.push(
    "This brief is evidence for a decision, not a directive. It does not replace professional legal, medical, or financial advice.",
  );

  const verdict = `Verdict: ${findings.length} finding${findings.length === 1 ? "" : "s"} checked against ${citations.length} source${citations.length === 1 ? "" : "s"}, cite check tier ${tier}.`;
  const freeSummary = `${verdict}\n\n${findings[0]}`;

  return {
    cite_check_tier: tier,
    free_summary: freeSummary,
    full_markdown: bodyParts.join("\n\n"),
    citations,
  };
}
