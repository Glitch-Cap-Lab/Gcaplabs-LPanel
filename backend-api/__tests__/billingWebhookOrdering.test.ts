// @ts-nocheck
/**
 * Stripe webhook handling: redelivery, reordering, unknown customers, stale events.
 * Billing stays disabled in product; nothing here talks to Stripe (events are
 * plain objects, signatures are generated locally with a test secret).
 */

const DEFAULTS = { vcpu: 4, ram_mb: 4096, disk_gb: 50 };

// A tiny stand-in for the `subscriptions` table that applies the handler's four
// statements with their WHERE/ON CONFLICT semantics.
function createFakeDb() {
  const rows = new Map(); // stripe_subscription_id -> row
  const query = jest.fn(async (sql, params = []) => {
    const text = String(sql);
    const guardsCanceled = /status <> 'canceled'/.test(text);
    if (/^\s*INSERT INTO subscriptions/.test(text)) {
      const [userId, customer, subId, plan, agentLimit, vcpu, ramMb, diskGb] = params;
      const existing = rows.get(subId);
      if (!existing) {
        rows.set(subId, {
          user_id: userId, stripe_customer_id: customer, stripe_subscription_id: subId,
          plan, status: "active", agent_limit: agentLimit, vcpu, ram_mb: ramMb, disk_gb: diskGb,
          period_extensions: 0,
        });
      } else if (!(guardsCanceled && existing.status === "canceled")) {
        Object.assign(existing, { plan, status: "active", agent_limit: agentLimit, vcpu, ram_mb: ramMb, disk_gb: diskGb });
      }
      return { rowCount: 1, rows: [] };
    }
    const apply = (subId, mutate) => {
      const row = rows.get(subId);
      if (!row || (guardsCanceled && row.status === "canceled")) return { rowCount: 0, rows: [] };
      mutate(row);
      return { rowCount: 1, rows: [] };
    };
    if (/SET status = 'active'/.test(text)) {
      return apply(params[0], (r) => { r.status = "active"; r.period_extensions += 1; });
    }
    if (/SET status = 'past_due'/.test(text)) {
      return apply(params[0], (r) => { r.status = "past_due"; });
    }
    if (/SET plan = 'free', status = 'canceled'/.test(text)) {
      const [agentLimit, vcpu, ramMb, diskGb, subId] = params;
      return apply(subId, (r) => Object.assign(r, { plan: "free", status: "canceled", agent_limit: agentLimit, vcpu, ram_mb: ramMb, disk_gb: diskGb }));
    }
    throw new Error(`unexpected SQL: ${text}`);
  });
  return { rows, query };
}

function load() {
  jest.resetModules();
  process.env.PLATFORM_MODE = "selfhosted";
  process.env.BILLING_ENABLED = "false";
  delete process.env.STRIPE_SECRET_KEY;
  const db = createFakeDb();
  jest.doMock("../db", () => db);
  jest.doMock("../platformSettings", () => ({
    getBackupPlanLimits: jest.fn().mockResolvedValue({}),
    getDeploymentDefaults: jest.fn().mockResolvedValue(DEFAULTS),
  }));
  return { billing: require("../billing"), db };
}

const checkout = (sub = "sub_1", over = {}) => ({
  id: `evt_checkout_${sub}`,
  type: "checkout.session.completed",
  data: { object: { id: "cs_1", customer: "cus_1", subscription: sub, metadata: { userId: "user-1", plan: "pro" }, ...over } },
});
const paid = (sub = "sub_1") => ({ id: "evt_paid", type: "invoice.paid", data: { object: { subscription: sub } } });
const failed = (sub = "sub_1") => ({ id: "evt_failed", type: "invoice.payment_failed", data: { object: { subscription: sub } } });
const deleted = (sub = "sub_1") => ({ id: "evt_deleted", type: "customer.subscription.deleted", data: { object: { id: sub } } });

afterEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  delete process.env.PLATFORM_MODE;
  delete process.env.BILLING_ENABLED;
});

describe("stripe webhook handling", () => {
  describe("duplicate delivery", () => {
    it("treats a redelivered checkout.session.completed as a no-op upsert", async () => {
      const { billing, db } = load();
      await billing.handleWebhookEvent(checkout());
      const first = { ...db.rows.get("sub_1") };
      await billing.handleWebhookEvent(checkout());
      expect(db.rows.size).toBe(1);
      expect(db.rows.get("sub_1")).toEqual(first);
      expect(first).toMatchObject({ plan: "pro", status: "active", user_id: "user-1" });
    });

    it("keeps a redelivered subscription.deleted canceled and on the free limits", async () => {
      const { billing, db } = load();
      await billing.handleWebhookEvent(checkout());
      await billing.handleWebhookEvent(deleted());
      const once = { ...db.rows.get("sub_1") };
      await billing.handleWebhookEvent(deleted());
      expect(db.rows.get("sub_1")).toEqual(once);
      expect(once).toMatchObject({ plan: "free", status: "canceled" });
    });
  });

  describe("reordered events", () => {
    it("does not reactivate a canceled subscription when invoice.paid arrives after deletion", async () => {
      const { billing, db } = load();
      await billing.handleWebhookEvent(checkout());
      await billing.handleWebhookEvent(deleted());
      await billing.handleWebhookEvent(paid());
      expect(db.rows.get("sub_1")).toMatchObject({ plan: "free", status: "canceled" });
    });

    it("does not turn a canceled subscription past_due on a late payment failure", async () => {
      const { billing, db } = load();
      await billing.handleWebhookEvent(checkout());
      await billing.handleWebhookEvent(deleted());
      await billing.handleWebhookEvent(failed());
      expect(db.rows.get("sub_1").status).toBe("canceled");
    });

    it("does not let a replayed checkout.session.completed revive a canceled subscription", async () => {
      const { billing, db } = load();
      await billing.handleWebhookEvent(checkout());
      await billing.handleWebhookEvent(deleted());
      await billing.handleWebhookEvent(checkout());
      expect(db.rows.get("sub_1")).toMatchObject({ plan: "free", status: "canceled" });
    });

    it("still recovers past_due -> active on a paid invoice, and a new subscription id resubscribes", async () => {
      const { billing, db } = load();
      await billing.handleWebhookEvent(checkout());
      await billing.handleWebhookEvent(failed());
      expect(db.rows.get("sub_1").status).toBe("past_due");
      await billing.handleWebhookEvent(paid());
      expect(db.rows.get("sub_1").status).toBe("active");
      await billing.handleWebhookEvent(deleted());
      await billing.handleWebhookEvent(checkout("sub_2"));
      expect(db.rows.get("sub_2")).toMatchObject({ plan: "pro", status: "active" });
      expect(db.rows.get("sub_1").status).toBe("canceled");
    });

    it("accepts invoice.paid before the checkout event without creating a row", async () => {
      const { billing, db } = load();
      await billing.handleWebhookEvent(paid());
      expect(db.rows.size).toBe(0);
      await billing.handleWebhookEvent(checkout());
      expect(db.rows.get("sub_1").status).toBe("active");
    });
  });

  describe("unknown customer or subscription", () => {
    it("resolves without error and writes nothing for unknown subscriptions", async () => {
      const { billing, db } = load();
      await expect(billing.handleWebhookEvent(paid("sub_unknown"))).resolves.toBeUndefined();
      await expect(billing.handleWebhookEvent(failed("sub_unknown"))).resolves.toBeUndefined();
      await expect(billing.handleWebhookEvent(deleted("sub_unknown"))).resolves.toBeUndefined();
      expect(db.rows.size).toBe(0);
    });

    it("ignores a checkout session that carries no userId instead of storing an ownerless row", async () => {
      const { billing, db } = load();
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      await billing.handleWebhookEvent(checkout("sub_1", { metadata: {} }));
      expect(db.rows.size).toBe(0);
      expect(db.query).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("ignores event types it does not handle", async () => {
      const { billing, db } = load();
      await billing.handleWebhookEvent({ id: "evt_x", type: "charge.refunded", data: { object: {} } });
      expect(db.query).not.toHaveBeenCalled();
    });
  });
});

describe("stripe webhook HTTP boundary", () => {
  const SECRET = "whsec_test_secret";

  function loadServer() {
    jest.resetModules();
    process.env.PLATFORM_MODE = "paas";
    process.env.BILLING_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_unused";
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    const db = createFakeDb();
    db.connect = jest.fn();
    db.on = jest.fn();
    jest.doMock("../db", () => db);
    jest.doMock("../redisQueue", () => ({ addDeploymentJob: jest.fn() }));
    jest.doMock("../scheduler", () => ({ start: jest.fn(), stop: jest.fn() }));
    jest.doMock("../platformSettings", () => ({
      ...jest.requireActual("../platformSettings"),
      getBackupPlanLimits: jest.fn().mockResolvedValue({}),
      getDeploymentDefaults: jest.fn().mockResolvedValue(DEFAULTS),
    }));
    const request = require("supertest");
    const stripe = require("stripe")("sk_test_unused");
    const app = require("../server");
    const post = (event, signature) => {
      const payload = JSON.stringify(event);
      const header =
        signature ?? stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
      return request(app)
        .post("/stripe/webhook")
        .set("Content-Type", "application/json")
        .set("Stripe-Signature", header)
        .send(payload);
    };
    return { db, post };
  }

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("rejects a bad signature without touching the database", async () => {
    const { db, post } = loadServer();
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await post(checkout(), "t=1,v1=deadbeef");
    err.mockRestore();
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("acknowledges a duplicate signed delivery and leaves one subscription", async () => {
    const { db, post } = loadServer();
    expect((await post(checkout())).status).toBe(200);
    expect((await post(checkout())).status).toBe(200);
    expect(db.rows.size).toBe(1);
  });

  it("acknowledges a late invoice.paid after deletion without reactivating", async () => {
    const { db, post } = loadServer();
    await post(checkout());
    await post(deleted());
    expect((await post(paid())).status).toBe(200);
    expect(db.rows.get("sub_1").status).toBe("canceled");
  });
});
