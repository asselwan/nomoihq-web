#!/usr/bin/env node
// Minimal smoke test for the free/paid gate, no network. Run: node scripts/server.test.mjs
import assert from "node:assert/strict";
import { validSlug, validSessionId } from "../server.mjs";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok: ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name}: ${err.message}`);
  }
}

check("validSlug accepts a normal slug", () => assert.equal(validSlug("sample-demo"), true));
check("validSlug rejects path traversal", () => assert.equal(validSlug("../etc/passwd"), false));
check("validSlug rejects empty", () => assert.equal(validSlug(""), false));
check("validSessionId accepts a well formed session id", () => assert.equal(validSessionId("cs_test_a1b2c3d4"), true));
check("validSessionId rejects a bare string", () => assert.equal(validSessionId("not-a-session"), false));
check("validSessionId rejects injected characters", () => assert.equal(validSessionId("cs_test_a1b2;drop table"), false));

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
