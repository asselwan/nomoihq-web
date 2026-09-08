import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(port, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Server did not become ready in time");
}

// Stands in for api.stripe.com. Checkout Session creation always succeeds;
// refund creation is recorded so tests can assert a RED tier really refunds.
async function startFakeStripeApi() {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.startsWith("/refunds")) {
      res.end(JSON.stringify({ id: "re_test_refund_1", object: "refund", status: "succeeded" }));
      return;
    }
    res.end(JSON.stringify({
      id: "cs_test_checkout_created_1",
      object: "checkout.session",
      url: "https://checkout.stripe.test/c/pay/cs_test_checkout_created_1",
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port, requests };
}

function signedStripeEvent(event, secret) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return { body, signature: `t=${timestamp},v1=${signature}` };
}

function validCheckoutEvent(overrides = {}) {
  const session = {
    object: "checkout.session",
    id: "cs_test_order_1",
    created: 1767225600,
    mode: "payment",
    payment_status: "paid",
    livemode: false,
    currency: "usd",
    amount_total: 4900,
    payment_intent: "pi_test_order_1",
    client_reference_id: "nomoi_research_question_v1",
    customer_details: { email: "buyer@example.com" },
    metadata: {
      product: "nomoi_research_question_v1",
      tier_key: "standard_49",
      is_test: "true",
      question: "What changed in the UAE clinic front desk AI market in the last 12 months",
    },
    ...overrides,
  };
  return { id: "evt_checkout_1", type: "checkout.session.completed", data: { object: session } };
}

async function startServer({ fakeStripe, ordersDir, webhookSecret }) {
  const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const serverPath = path.join(rootDir, "server.mjs");
  const port = await freePort();
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      ORDERS_DIR: ordersDir,
      STRIPE_SECRET_KEY: "sk_test_server_only",
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      STRIPE_PRICE_ID_STANDARD: "price_test_standard",
      STRIPE_PRICE_ID_FLAGSHIP: "price_test_flagship",
      STRIPE_API_BASE_URL: `http://127.0.0.1:${fakeStripe.port}`,
      PUBLIC_BASE_URL: "https://nomoihq.test",
      RESEARCH_WORKER_TOKEN: "worker-test-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(port);
  return { child, port };
}

test("checkout creates a Stripe session carrying the question and tier", async () => {
  const ordersDir = await fs.mkdtemp(path.join(os.tmpdir(), "nomoihq-orders-"));
  const webhookSecret = "whsec_test_secret";
  const fakeStripe = await startFakeStripeApi();
  const { child, port } = await startServer({ fakeStripe, ordersDir, webhookSecret });
  try {
    const tooShort = await fetch(`http://127.0.0.1:${port}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.com", question: "too short", tier: "standard" }),
    });
    assert.equal(tooShort.status, 400);

    const checkout = await fetch(`http://127.0.0.1:${port}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "buyer@example.com",
        question: "What changed in the UAE clinic front desk AI market in the last 12 months",
        tier: "standard",
      }),
    });
    assert.equal(checkout.status, 201);
    assert.deepEqual(await checkout.json(), { checkout_url: "https://checkout.stripe.test/c/pay/cs_test_checkout_created_1" });
    const params = new URLSearchParams(fakeStripe.requests[0].body);
    assert.equal(params.get("line_items[0][price]"), "price_test_standard");
    assert.equal(params.get("metadata[tier_key]"), "standard_49");
    assert.match(params.get("metadata[question]"), /UAE clinic front desk/);
    assert.equal(params.get("success_url"), "https://nomoihq.test/deliver.html?session_id={CHECKOUT_SESSION_ID}");
  } finally {
    child.kill("SIGTERM");
    fakeStripe.server.close();
    await fs.rm(ordersDir, { recursive: true, force: true });
  }
});

test("a GREEN worker report delivers the brief; order status carries it", async () => {
  const ordersDir = await fs.mkdtemp(path.join(os.tmpdir(), "nomoihq-orders-"));
  const webhookSecret = "whsec_test_secret";
  const fakeStripe = await startFakeStripeApi();
  const { child, port } = await startServer({ fakeStripe, ordersDir, webhookSecret });
  try {
    const event = validCheckoutEvent();
    const signed = signedStripeEvent(event, webhookSecret);
    const webhook = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": signed.signature },
      body: signed.body,
    });
    assert.equal(webhook.status, 200);
    assert.deepEqual(await webhook.json(), { received: true, created: true, session_id: "cs_test_order_1" });

    const preClaim = await fetch(`http://127.0.0.1:${port}/api/order/cs_test_order_1`);
    assert.equal((await preClaim.json()).status, "paid");

    const claim = await fetch(`http://127.0.0.1:${port}/api/worker/claim`, { headers: { Authorization: "Bearer worker-test-token" } });
    const claimed = await claim.json();
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.session_id, "cs_test_order_1");
    assert.equal(claimed.tier_key, "standard_49");
    assert.match(claimed.question, /UAE clinic front desk/);

    const noSecondClaim = await fetch(`http://127.0.0.1:${port}/api/worker/claim`, { headers: { Authorization: "Bearer worker-test-token" } });
    assert.equal((await noSecondClaim.json()).claimed, false);

    const badClaimReport = await fetch(`http://127.0.0.1:${port}/api/worker/cs_test_order_1/report`, {
      method: "POST",
      headers: { Authorization: "Bearer worker-test-token", "Content-Type": "application/json", "x-worker-claim": "wrong-token" },
      body: JSON.stringify({ cite_check_tier: "GREEN" }),
    });
    assert.equal(badClaimReport.status, 409);

    const report = await fetch(`http://127.0.0.1:${port}/api/worker/cs_test_order_1/report`, {
      method: "POST",
      headers: { Authorization: "Bearer worker-test-token", "Content-Type": "application/json", "x-worker-claim": claimed.claim },
      body: JSON.stringify({
        cite_check_tier: "GREEN",
        free_summary: "Verdict: 1 finding checked against 1 source, cite check tier GREEN.\n\nFinding one.",
        full_markdown: "## Findings\n\nFinding one, cited.\n\n## Sources\n\n- example.com, source: https://example.com/source",
        citations: [{ url: "https://example.com/source", title: "example.com", status: "VERIFIED" }],
      }),
    });
    assert.equal(report.status, 200);
    assert.deepEqual(await report.json(), { session_id: "cs_test_order_1", status: "ready", cite_check_tier: "GREEN" });

    const status = await fetch(`http://127.0.0.1:${port}/api/order/cs_test_order_1`);
    const statusBody = await status.json();
    assert.equal(statusBody.status, "ready");
    assert.equal(statusBody.cite_check_tier, "GREEN");
    assert.match(statusBody.full_markdown, /Finding one, cited/);
    assert.equal(statusBody.citations.length, 1);

    // Payment for a different order id must never unlock this report.
    const wrongOrder = await fetch(`http://127.0.0.1:${port}/api/order/cs_test_unrelated_order`);
    assert.equal(wrongOrder.status, 404);
  } finally {
    child.kill("SIGTERM");
    fakeStripe.server.close();
    await fs.rm(ordersDir, { recursive: true, force: true });
  }
});

test("a RED worker report refuses delivery and refunds through Stripe", async () => {
  const ordersDir = await fs.mkdtemp(path.join(os.tmpdir(), "nomoihq-orders-"));
  const webhookSecret = "whsec_test_secret";
  const fakeStripe = await startFakeStripeApi();
  const { child, port } = await startServer({ fakeStripe, ordersDir, webhookSecret });
  try {
    const event = validCheckoutEvent({ id: "cs_test_red_order" });
    event.id = "evt_checkout_red";
    event.data.object.payment_intent = "pi_test_red_order";
    const signed = signedStripeEvent(event, webhookSecret);
    await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": signed.signature },
      body: signed.body,
    });

    const claim = await fetch(`http://127.0.0.1:${port}/api/worker/claim`, { headers: { Authorization: "Bearer worker-test-token" } });
    const claimed = await claim.json();

    const report = await fetch(`http://127.0.0.1:${port}/api/worker/cs_test_red_order/report`, {
      method: "POST",
      headers: { Authorization: "Bearer worker-test-token", "Content-Type": "application/json", "x-worker-claim": claimed.claim },
      body: JSON.stringify({ cite_check_tier: "RED", reason: "load_bearing_claim_unverified" }),
    });
    assert.equal(report.status, 200);
    const reportBody = await report.json();
    assert.equal(reportBody.status, "refused_refunded");
    assert.equal(reportBody.cite_check_tier, "RED");
    assert.equal(reportBody.refund_id, "re_test_refund_1");

    const refundCall = fakeStripe.requests.find((r) => r.url.startsWith("/refunds"));
    assert.ok(refundCall, "expected a Stripe refund call");
    const refundParams = new URLSearchParams(refundCall.body);
    assert.equal(refundParams.get("payment_intent"), "pi_test_red_order");

    const status = await fetch(`http://127.0.0.1:${port}/api/order/cs_test_red_order`);
    const statusBody = await status.json();
    assert.equal(statusBody.status, "refused_refunded");
    assert.equal(statusBody.refund_id, "re_test_refund_1");
    assert.equal(statusBody.full_markdown, undefined);
    assert.equal(statusBody.citations, undefined);
  } finally {
    child.kill("SIGTERM");
    fakeStripe.server.close();
    await fs.rm(ordersDir, { recursive: true, force: true });
  }
});

test("an INCONCLUSIVE report also refuses delivery, same as RED", async () => {
  const ordersDir = await fs.mkdtemp(path.join(os.tmpdir(), "nomoihq-orders-"));
  const webhookSecret = "whsec_test_secret";
  const fakeStripe = await startFakeStripeApi();
  const { child, port } = await startServer({ fakeStripe, ordersDir, webhookSecret });
  try {
    const event = validCheckoutEvent({ id: "cs_test_inconclusive_order" });
    event.id = "evt_checkout_inconclusive";
    event.data.object.payment_intent = "pi_test_inconclusive_order";
    const signed = signedStripeEvent(event, webhookSecret);
    await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": signed.signature },
      body: signed.body,
    });
    const claim = await (await fetch(`http://127.0.0.1:${port}/api/worker/claim`, { headers: { Authorization: "Bearer worker-test-token" } })).json();
    const report = await fetch(`http://127.0.0.1:${port}/api/worker/cs_test_inconclusive_order/report`, {
      method: "POST",
      headers: { Authorization: "Bearer worker-test-token", "Content-Type": "application/json", "x-worker-claim": claim.claim },
      body: JSON.stringify({ cite_check_tier: "INCONCLUSIVE" }),
    });
    assert.equal((await report.json()).status, "refused_refunded");
  } finally {
    child.kill("SIGTERM");
    fakeStripe.server.close();
    await fs.rm(ordersDir, { recursive: true, force: true });
  }
});

test("worker endpoints reject a missing or wrong bearer token", async () => {
  const ordersDir = await fs.mkdtemp(path.join(os.tmpdir(), "nomoihq-orders-"));
  const webhookSecret = "whsec_test_secret";
  const fakeStripe = await startFakeStripeApi();
  const { child, port } = await startServer({ fakeStripe, ordersDir, webhookSecret });
  try {
    const noAuth = await fetch(`http://127.0.0.1:${port}/api/worker/claim`);
    assert.equal(noAuth.status, 401);
    const wrongAuth = await fetch(`http://127.0.0.1:${port}/api/worker/claim`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(wrongAuth.status, 401);
  } finally {
    child.kill("SIGTERM");
    fakeStripe.server.close();
    await fs.rm(ordersDir, { recursive: true, force: true });
  }
});

test("checkout refuses until Stripe test keys and both price IDs are configured", async () => {
  const ordersDir = await fs.mkdtemp(path.join(os.tmpdir(), "nomoihq-orders-"));
  const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(rootDir, "server.mjs")], {
    env: { ...process.env, NODE_ENV: "test", PORT: String(port), ORDERS_DIR: ordersDir, PUBLIC_BASE_URL: "https://nomoihq.test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(port);
    const checkout = await fetch(`http://127.0.0.1:${port}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.com", question: "A question long enough to pass validation here", tier: "standard" }),
    });
    assert.equal(checkout.status, 503);
  } finally {
    child.kill("SIGTERM");
    await fs.rm(ordersDir, { recursive: true, force: true });
  }
});
