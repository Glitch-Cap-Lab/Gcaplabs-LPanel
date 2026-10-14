// @ts-nocheck
const { bindExternalIdentity } = require("../headmasterIdentityBinding");

// Fake agents table whose UPDATE honours the `external_namespace IS NULL`
// guard atomically, like Postgres row locking does.
function fakeDb(rows) {
  const agents = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
    agents,
    query: jest.fn(async (sql, params) => {
      // Yield so concurrent callers genuinely interleave.
      await new Promise((r) => setImmediate(r));
      if (/^UPDATE agents/.test(sql.trim())) {
        const [ns, ext, owner, id] = params;
        const row = agents.get(id);
        if (!row || row.external_namespace != null) return { rows: [] };
        Object.assign(row, { external_namespace: ns, external_id: ext, external_owner_uuid: owner });
        return { rows: [{ ...row }] };
      }
      if (/^SELECT \* FROM agents/.test(sql.trim())) {
        const row = agents.get(params[0]);
        return { rows: row ? [{ ...row }] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
}

const A = {
  namespace: "headmaster",
  externalId: "11111111-1111-4111-8111-111111111111",
  ownerUuid: "22222222-2222-4222-8222-222222222222",
};
const B = { ...A, externalId: "33333333-3333-4333-8333-333333333333" };

describe("bindExternalIdentity", () => {
  it("binds an unbound agent once and is idempotent on retry", async () => {
    const db = fakeDb([{ id: "ag1", external_namespace: null }]);
    const first = await bindExternalIdentity(db, "ag1", A);
    expect(first.newlyAdopted).toBe(true);
    const again = await bindExternalIdentity(db, "ag1", A);
    expect(again.newlyAdopted).toBe(false);
    expect(again.agent.external_id).toBe(A.externalId);
  });

  it("two concurrent binds of the same identity: exactly one adopts, both succeed", async () => {
    const db = fakeDb([{ id: "ag1", external_namespace: null }]);
    const results = await Promise.all([
      bindExternalIdentity(db, "ag1", A),
      bindExternalIdentity(db, "ag1", A),
    ]);
    expect(results.filter((r) => r.newlyAdopted)).toHaveLength(1);
  });

  it("concurrent binds of different identities: the loser gets 409 and cannot overwrite", async () => {
    const db = fakeDb([{ id: "ag1", external_namespace: null }]);
    const settled = await Promise.allSettled([
      bindExternalIdentity(db, "ag1", A),
      bindExternalIdentity(db, "ag1", B),
    ]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    const failed = settled.filter((s) => s.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.statusCode).toBe(409);
    expect(db.agents.get("ag1").external_id).toBe(ok[0].value.agent.external_id);
  });

  it("returns 404 when the agent disappeared", async () => {
    const db = fakeDb([]);
    await expect(bindExternalIdentity(db, "missing", A)).rejects.toMatchObject({ statusCode: 404 });
  });
});
