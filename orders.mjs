// NOMOI HQ order flow: question intake -> Stripe Checkout -> webhook entitlement
// -> worker claim -> pipeline delivery -> gated read-back. A RED or
// INCONCLUSIVE cite-check tier is never delivered; the order is refunded
// through the same Stripe secret key instead. Pattern mirrors
// glowhum-web/server.mjs (checkout session, HMAC webhook, immutable claim
// files for idempotency) and creative-jobs.mjs (bearer-token worker claim),
// adapted for a paid-then-produced research brief instead of a paid-then-
// rendered video episode.
//
// Storage layout under ORDERS_DIR:
//   events/<event_id>.json        webhook idempotency claim
//   payments/<payment_intent_id>.json  payment -> order binding
//   entitlements/<session_id>.json     active | revoked
//   orders/<session_id>/receipt.json   order state machine
//   orders/<session_id>/claim.json     worker claim token (first writer wins)
//   orders/<session_id>/report.json    delivered brief (only when ready)

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_ID_STANDARD = process.env.STRIPE_PRICE_ID_STANDARD || "";
const STRIPE_PRICE_ID_FLAGSHIP = process.env.STRIPE_PRICE_ID_FLAGSHIP || "";
const STRIPE_ALLOW_LIVE = process.env.STRIPE_ALLOW_LIVE === "true";
const RESEARCH_WORKER_TOKEN = process.env.RESEARCH_WORKER_TOKEN || "";
const STRIPE_API_BASE_URL = process.env.STRIPE_API_BASE_URL || "https://api.stripe.com/v1";

const PRODUCT_MARKER = "nomoi_research_question_v1";
const WEBHOOK_MAX_BYTES = 1024 * 1024;
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const DELIVERABLE_TIERS = new Set(["GREEN", "AMBER"]);

const TIERS = {
  standard_49: { priceId: STRIPE_PRICE_ID_STANDARD, amountCents: 4900, label: "Standard brief" },
  flagship_199: { priceId: STRIPE_PRICE_ID_FLAGSHIP, amountCents: 19900, label: "Flagship brief" },
};

export function ordersPaths(ordersDir) {
  return {
    order: (id) => path.join(ordersDir, "orders", id, "receipt.json"),
    orderDir: (id) => path.join(ordersDir, "orders", id),
    claim: (id) => path.join(ordersDir, "orders", id, "claim.json"),
    report: (id) => path.join(ordersDir, "orders", id, "report.json"),
    event: (id) => path.join(ordersDir, "events", `${id}.json`),
    payment: (id) => path.join(ordersDir, "payments", `${id}.json`),
    entitlement: (id) => path.join(ordersDir, "entitlements", `${id}.json`),
    ordersRoot: () => path.join(ordersDir, "orders"),
  };
}

function stripeKeyMode() {
  if (/^(sk|rk)_test_/.test(STRIPE_SECRET_KEY)) return "test";
  if (/^(sk|rk)_live_/.test(STRIPE_SECRET_KEY)) return "live";
  return "unknown";
}

export function stripeIsReady() {
  const mode = stripeKeyMode();
  const pricesConfigured = Boolean(TIERS.standard_49.priceId) && Boolean(TIERS.flagship_199.priceId);
  return pricesConfigured && (mode === "test" || (mode === "live" && STRIPE_ALLOW_LIVE));
}

function expectedLivemode() {
  return stripeKeyMode() === "live";
}

export function validSessionId(id) {
  return typeof id === "string" && /^cs_[A-Za-z0-9_]{8,255}$/.test(id);
}

export function validEventId(id) {
  return typeof id === "string" && /^evt_[A-Za-z0-9_]{8,255}$/.test(id);
}

export function validPaymentIntentId(id) {
  return typeof id === "string" && /^pi_[A-Za-z0-9_]{8,255}$/.test(id);
}

function validateEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(email.trim());
}

function safeText(value, maxLength) {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/\s+/g, " ");
  return text.length <= maxLength ? text : "";
}

export function validateOrderInput(input) {
  const email = safeText(input?.email, 254);
  const question = safeText(input?.question, 2000);
  const tierKey = input?.tier === "flagship" ? "flagship_199" : input?.tier === "standard" ? "standard_49" : null;
  if (!validateEmail(email)) return { error: "Enter a valid email address." };
  if (question.length < 20) return { error: "Ask a full question, at least 20 characters." };
  if (!tierKey) return { error: "Choose the standard or flagship brief." };
  return { email, question, tierKey };
}

function configuredPublicBaseUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function createCheckoutSession(order, baseUrl) {
  const tier = TIERS[order.tierKey];
  const isTest = stripeKeyMode() === "test";
  const params = new URLSearchParams({
    mode: "payment",
    customer_email: order.email,
    client_reference_id: PRODUCT_MARKER,
    success_url: `${baseUrl}/deliver.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/?checkout=cancelled`,
    "line_items[0][quantity]": "1",
    "line_items[0][price]": tier.priceId,
    "metadata[product]": PRODUCT_MARKER,
    "metadata[tier_key]": order.tierKey,
    "metadata[is_test]": String(isTest),
    "metadata[question]": order.question.slice(0, 480),
    "payment_intent_data[metadata][product]": PRODUCT_MARKER,
    "payment_intent_data[metadata][tier_key]": order.tierKey,
    "payment_intent_data[metadata][is_test]": String(isTest),
  });
  const response = await fetch(`${STRIPE_API_BASE_URL}/checkout/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!response.ok) throw new Error("Stripe Checkout could not be created");
  const session = await response.json();
  if (!session || typeof session.url !== "string") throw new Error("Stripe Checkout returned no URL");
  return session;
}

async function refundPayment(paymentIntentId, reason) {
  const params = new URLSearchParams({
    payment_intent: paymentIntentId,
    reason: "requested_by_customer",
    "metadata[refund_reason]": reason,
  });
  const response = await fetch(`${STRIPE_API_BASE_URL}/refunds`, {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Stripe refund failed: ${body?.error?.message || response.status}`);
  return body;
}

function signatureParts(header) {
  let timestamp = null;
  const signatures = [];
  for (const part of String(header || "").split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t" && value) timestamp = Number(value);
    if (key === "v1" && value) signatures.push(value);
  }
  return { timestamp, signatures };
}

export function verifyStripeSignature(rawBody, header) {
  if (!STRIPE_WEBHOOK_SECRET) return false;
  const { timestamp, signatures } = signatureParts(header);
  if (!Number.isInteger(timestamp) || signatures.length === 0) return false;
  const skewSeconds = Math.abs(Math.floor(Date.now() / 1000)-timestamp);
  if (skewSeconds > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return signatures.some((sig) => {
    const sigBuffer = Buffer.from(sig, "hex");
    return expectedBuffer.length === sigBuffer.length && crypto.timingSafeEqual(expectedBuffer, sigBuffer);
  });
}

export function isValidPaidCheckoutSession(session) {
  if (!session || session.object !== "checkout.session" || !validSessionId(session.id)) return false;
  if (session.mode !== "payment" || session.payment_status !== "paid") return false;
  if (session.livemode !== expectedLivemode()) return false;
  if (session.client_reference_id !== PRODUCT_MARKER) return false;
  if (session.metadata?.product !== PRODUCT_MARKER) return false;
  const tierKey = session.metadata?.tier_key;
  const tier = TIERS[tierKey];
  if (!tier) return false;
  if (session.currency !== "usd") return false;
  if (session.amount_total !== tier.amountCents) return false;
  if (!validPaymentIntentId(session.payment_intent)) return false;
  if (!validateEmail(session.customer_details?.email || "")) return false;
  if (!safeText(session.metadata?.question, 480)) return false;
  return true;
}

async function writeImmutableFile(destination, contents) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${crypto.randomBytes(8).toString("hex")}`;
  await fs.writeFile(temporary, contents, { flag: "wx" });
  try {
    await fs.link(temporary, destination);
    return { created: true };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const current = await fs.readFile(destination);
    const incoming = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    if (!current.equals(incoming)) {
      const conflict = new Error("Existing immutable file differs");
      conflict.code = "CONFLICT";
      throw conflict;
    }
    return { created: false };
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeJsonAtomic(destination, value) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${crypto.randomBytes(8).toString("hex")}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function claimEvent(paths, eventId, orderId) {
  const claim = `${JSON.stringify({ event_id: eventId, order_id: orderId })}\n`;
  try {
    const result = await writeImmutableFile(paths.event(eventId), claim);
    return result.created;
  } catch (error) {
    if (error?.code === "CONFLICT") {
      const conflict = new Error("Event ID is already bound to another order");
      conflict.code = "EVENT_CONFLICT";
      throw conflict;
    }
    throw error;
  }
}

async function bindPayment(paths, job) {
  const binding = `${JSON.stringify({ payment_intent_id: job.payment_intent_id, order_id: job.session_id, product: PRODUCT_MARKER })}\n`;
  try {
    await writeImmutableFile(paths.payment(job.payment_intent_id), binding);
  } catch (error) {
    if (error?.code === "CONFLICT") {
      const conflict = new Error("PaymentIntent is already bound to another order");
      conflict.code = "PAYMENT_CONFLICT";
      throw conflict;
    }
    throw error;
  }
}

async function grantEntitlement(paths, job) {
  const entitlement = {
    entitlement_id: job.session_id,
    order_id: job.session_id,
    payment_intent_id: job.payment_intent_id,
    product: PRODUCT_MARKER,
    status: "active",
    is_test: job.is_test,
    granted_at: job.created_at,
    granted_by_event_id: job.event_id,
    revoked_at: null,
    revoked_by_event_id: null,
  };
  try {
    await writeImmutableFile(paths.entitlement(job.session_id), `${JSON.stringify(entitlement, null, 2)}\n`);
  } catch (error) {
    if (error?.code !== "CONFLICT") throw error;
  }
}

async function writeOrderOnce(paths, job) {
  const receipt = { ...job };
  try {
    const result = await writeImmutableFile(paths.order(job.session_id), `${JSON.stringify(receipt, null, 2)}\n`);
    return { created: result.created, order: receipt };
  } catch (error) {
    if (error?.code !== "CONFLICT") throw error;
    const existing = JSON.parse(await fs.readFile(paths.order(job.session_id), "utf8"));
    if (existing.event_id === job.event_id) return { created: false, order: existing };
    const conflict = new Error("Order is already bound to another event");
    conflict.code = "ORDER_CONFLICT";
    throw conflict;
  }
}

export function jobFromCheckoutSession(session, event) {
  const createdSeconds = Number(session.created);
  const createdAt = Number.isFinite(createdSeconds) ? new Date(createdSeconds * 1000).toISOString() : new Date().toISOString();
  return {
    session_id: session.id,
    email: safeText(session.customer_details?.email, 254),
    question: safeText(session.metadata?.question, 480),
    tier_key: session.metadata.tier_key,
    price_usd: TIERS[session.metadata.tier_key].amountCents / 100,
    payment_intent_id: session.payment_intent,
    product: PRODUCT_MARKER,
    is_test: !session.livemode,
    created_at: createdAt,
    status: "paid",
    event_id: event.id,
    cite_check_tier: null,
    refund_id: null,
    refunded_at: null,
  };
}

// ---- HTTP handlers, given an ordersDir root ----

export function makeOrderHandlers(ordersDir, publicBaseUrlEnv) {
  const paths = ordersPaths(ordersDir);

  async function handleCheckout(req, res, readJsonBody, sendJson) {
    let input;
    try {
      input = validateOrderInput(await readJsonBody(req));
    } catch {
      return sendJson(res, 400, { error: "Invalid order details." });
    }
    if (input.error) return sendJson(res, 400, { error: input.error });
    if (!stripeIsReady()) return sendJson(res, 503, { error: "Checkout is not ready yet." });
    const baseUrl = configuredPublicBaseUrl(publicBaseUrlEnv);
    if (!baseUrl) return sendJson(res, 503, { error: "Checkout is not ready yet." });
    try {
      const session = await createCheckoutSession({ email: input.email, question: input.question, tierKey: input.tierKey }, baseUrl);
      sendJson(res, 201, { checkout_url: session.url });
    } catch {
      sendJson(res, 502, { error: "Checkout could not be started. Please try again." });
    }
  }

  async function handleWebhook(req, res, readRawBody, sendJson) {
    let rawBody;
    try {
      rawBody = await readRawBody(req, WEBHOOK_MAX_BYTES);
    } catch {
      return sendJson(res, 400, { error: "Invalid webhook body" });
    }
    if (!verifyStripeSignature(rawBody, req.headers["stripe-signature"])) {
      return sendJson(res, 400, { error: "Invalid webhook signature" });
    }
    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: "Invalid webhook payload" });
    }
    if (!validEventId(event.id)) return sendJson(res, 400, { error: "Invalid webhook event" });
    if (event.type === "charge.refunded") return handleRefundWebhook(res, event, sendJson);
    if (event.type !== "checkout.session.completed") return sendJson(res, 200, { received: true, ignored: true });
    const session = event.data?.object;
    if (!isValidPaidCheckoutSession(session)) return sendJson(res, 400, { error: "Invalid Checkout session" });
    const job = jobFromCheckoutSession(session, event);
    try {
      await claimEvent(paths, job.event_id, job.session_id);
      await bindPayment(paths, job);
      await grantEntitlement(paths, job);
      const result = await writeOrderOnce(paths, job);
      sendJson(res, 200, { received: true, created: result.created, session_id: result.order.session_id });
    } catch (error) {
      if (["EVENT_CONFLICT", "ORDER_CONFLICT", "PAYMENT_CONFLICT"].includes(error?.code)) {
        return sendJson(res, 409, { error: "Webhook event conflicts with an existing order" });
      }
      sendJson(res, 500, { error: "Could not store order" });
    }
  }

  async function handleRefundWebhook(res, event, sendJson) {
    // Manual/customer-initiated refund on the same PaymentIntent revokes
    // the entitlement even though this side never called refundPayment().
    const charge = event.data?.object;
    if (!charge || charge.object !== "charge" || !charge.refunded || !validPaymentIntentId(charge.payment_intent)) {
      return sendJson(res, 200, { received: true, ignored: true });
    }
    try {
      const binding = JSON.parse(await fs.readFile(paths.payment(charge.payment_intent), "utf8"));
      const orderId = binding.order_id;
      const entitlement = JSON.parse(await fs.readFile(paths.entitlement(orderId), "utf8"));
      if (entitlement.status === "active") {
        await writeJsonAtomic(paths.entitlement(orderId), { ...entitlement, status: "revoked", revoked_at: new Date().toISOString(), revoked_by_event_id: event.id });
      }
      sendJson(res, 200, { received: true, order_id: orderId });
    } catch {
      sendJson(res, 200, { received: true, ignored: true });
    }
  }

  async function handleOrderStatus(res, sessionId, sendJson) {
    if (!validSessionId(sessionId)) return sendJson(res, 404, { error: "Not found" });
    let order;
    try {
      order = JSON.parse(await fs.readFile(paths.order(sessionId), "utf8"));
    } catch {
      return sendJson(res, 404, { error: "Not found" });
    }
    const base = { session_id: order.session_id, status: order.status, tier_key: order.tier_key, cite_check_tier: order.cite_check_tier };
    if (order.status === "ready") {
      let report;
      try {
        report = JSON.parse(await fs.readFile(paths.report(sessionId), "utf8"));
      } catch {
        return sendJson(res, 500, { error: "Report record missing for a ready order" });
      }
      return sendJson(res, 200, { ...base, free_summary: report.free_summary, full_markdown: report.full_markdown, citations: report.citations });
    }
    if (order.status === "refused_refunded") {
      return sendJson(res, 200, {
        ...base,
        message: "This brief did not clear the citation quality gate, so it was never delivered. The payment was refunded in full.",
        refund_id: order.refund_id,
      });
    }
    return sendJson(res, 200, { ...base, message: "Your brief is being produced. This page updates automatically." });
  }

  async function handleWorkerClaim(req, res, sendJson) {
    if (!RESEARCH_WORKER_TOKEN || req.headers.authorization !== `Bearer ${RESEARCH_WORKER_TOKEN}`) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    let entries;
    try {
      entries = await fs.readdir(paths.ordersRoot());
    } catch {
      return sendJson(res, 200, { claimed: false });
    }
    const candidates = [];
    for (const id of entries) {
      try {
        const order = JSON.parse(await fs.readFile(paths.order(id), "utf8"));
        if (order.status === "paid") candidates.push(order);
      } catch {
        // skip malformed/partial order directories
      }
    }
    candidates.sort((a, b) => Date.parse(a.created_at)-Date.parse(b.created_at));
    for (const order of candidates) {
      const claimToken = crypto.randomBytes(16).toString("hex");
      try {
        await writeImmutableFile(paths.claim(order.session_id), `${JSON.stringify({ claim: claimToken, claimed_at: new Date().toISOString() })}\n`);
      } catch (error) {
        if (error?.code === "CONFLICT") continue; // another worker already claimed this order
        throw error;
      }
      return sendJson(res, 200, { claimed: true, session_id: order.session_id, question: order.question, tier_key: order.tier_key, claim: claimToken });
    }
    return sendJson(res, 200, { claimed: false });
  }

  async function handleWorkerReport(req, res, sessionId, readJsonBody, sendJson) {
    if (!RESEARCH_WORKER_TOKEN || req.headers.authorization !== `Bearer ${RESEARCH_WORKER_TOKEN}`) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    if (!validSessionId(sessionId)) return sendJson(res, 404, { error: "Not found" });
    let claim;
    try {
      claim = JSON.parse(await fs.readFile(paths.claim(sessionId), "utf8"));
    } catch {
      return sendJson(res, 409, { error: "No open claim for this order" });
    }
    if (req.headers["x-worker-claim"] !== claim.claim) return sendJson(res, 409, { error: "Claim token mismatch" });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid report body" });
    }
    let order;
    try {
      order = JSON.parse(await fs.readFile(paths.order(sessionId), "utf8"));
    } catch {
      return sendJson(res, 404, { error: "Not found" });
    }
    if (order.status !== "paid") return sendJson(res, 409, { error: "Order is not awaiting a report" });

    const tier = typeof body?.cite_check_tier === "string" ? body.cite_check_tier : "FAILED";
    if (DELIVERABLE_TIERS.has(tier)) {
      if (typeof body.free_summary !== "string" || typeof body.full_markdown !== "string" || !Array.isArray(body.citations)) {
        return sendJson(res, 400, { error: "Deliverable report missing free_summary, full_markdown, or citations" });
      }
      await writeJsonAtomic(paths.report(sessionId), {
        cite_check_tier: tier,
        free_summary: body.free_summary,
        full_markdown: body.full_markdown,
        citations: body.citations,
        delivered_at: new Date().toISOString(),
      });
      await writeJsonAtomic(paths.order(sessionId), { ...order, status: "ready", cite_check_tier: tier });
      return sendJson(res, 200, { session_id: sessionId, status: "ready", cite_check_tier: tier });
    }

    // RED, INCONCLUSIVE, or FAILED: never delivered. Refund and close the order.
    try {
      const refund = await refundPayment(order.payment_intent_id, `cite_check_tier=${tier}`);
      await writeJsonAtomic(paths.order(sessionId), {
        ...order,
        status: "refused_refunded",
        cite_check_tier: tier,
        refund_id: refund.id || null,
        refunded_at: new Date().toISOString(),
      });
      return sendJson(res, 200, { session_id: sessionId, status: "refused_refunded", cite_check_tier: tier, refund_id: refund.id || null });
    } catch {
      return sendJson(res, 502, { error: "Refund could not be issued, will retry" });
    }
  }

  return { handleCheckout, handleWebhook, handleOrderStatus, handleWorkerClaim, handleWorkerReport };
}
