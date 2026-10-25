export {};

// Behaviour of the Headmaster launch exchange as callers see it: what is
// refused, with which status and code, and that storage outages fail closed.
const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);

const launch = require("../headmasterLaunch");

const ORIGIN = "https://headmaster.example.com";
const NONCE = "a".repeat(32);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to be rejected");
}

describe("headmaster launch exchange", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.JWT_SECRET = "j".repeat(64);
    delete process.env.HEADMASTER_LAUNCH_HMAC_KEY;
    process.env.HEADMASTER_S2S_TOKEN = "s2s-token";
    process.env.HEADMASTER_PARENT_ORIGIN = ORIGIN;
    mockDb.query.mockReset();
    mockDb.query.mockResolvedValue({ rows: [] });
  });

  afterAll(() => {
    process.env = saved;
  });

  describe("issuing a launch code", () => {
    const base = {
      gcapUserId: "user-1",
      gcapSessionId: "session-12345",
      browserNonce: NONCE,
      parentOrigin: ORIGIN,
    };

    test("is hidden when the deployment is not configured", async () => {
      delete process.env.HEADMASTER_S2S_TOKEN;
      const error = await rejection(launch.createLaunchCode(base));
      expect(error).toMatchObject({ statusCode: 503, code: "headmaster_disabled" });
    });

    test("requires a browser nonce from the initiating browser", async () => {
      const error = await rejection(launch.createLaunchCode({ ...base, browserNonce: "short" }));
      expect(error).toMatchObject({ statusCode: 400, code: "invalid_browser_nonce" });
    });

    test("refuses an origin other than the configured parent", async () => {
      const error = await rejection(
        launch.createLaunchCode({ ...base, parentOrigin: "https://evil.example.com" }),
      );
      expect(error).toMatchObject({ statusCode: 403, code: "origin_mismatch" });
    });

    test("refuses an account that has no explicit admin link", async () => {
      const error = await rejection(launch.createLaunchCode(base));
      expect(error).toMatchObject({ statusCode: 403, code: "no_admin_link" });
    });

    test("fails closed instead of issuing a code when storage is unavailable", async () => {
      mockDb.query.mockResolvedValue({
        rows: [{ nora_user_id: "n1", email: "a@b.c", role: "admin" }],
      });
      const error = await rejection(launch.createLaunchCode(base));
      expect(error).toMatchObject({ statusCode: 503, code: "storage_unavailable" });
    });
  });

  describe("redeeming a launch code", () => {
    test("rejects a malformed code before touching storage", async () => {
      const error = await rejection(
        launch.consumeLaunchCode({ code: "zz", browserNonceCookie: NONCE }),
      );
      expect(error).toMatchObject({ statusCode: 400, code: "invalid_code" });
    });

    test("requires the initiating browser's cookie", async () => {
      const error = await rejection(
        launch.consumeLaunchCode({ code: "d".repeat(64), browserNonceCookie: "" }),
      );
      expect(error).toMatchObject({ statusCode: 403, code: "browser_binding_missing" });
    });

    test("fails closed when storage is unavailable", async () => {
      const error = await rejection(
        launch.consumeLaunchCode({ code: "d".repeat(64), browserNonceCookie: NONCE }),
      );
      expect(error).toMatchObject({ statusCode: 503, code: "storage_unavailable" });
    });
  });

  describe("privileged sockets for launched sessions", () => {
    test("native sessions are not affected", async () => {
      await expect(launch.assertPrivilegedSocketSession({ id: "u1" })).resolves.toBeUndefined();
    });

    test("a launched session without an id is refused", async () => {
      const error = await rejection(launch.assertPrivilegedSocketSession({ hm: true }));
      expect(error).toMatchObject({ statusCode: 401, code: "session_invalid" });
    });

    test("a launched session is refused when its state cannot be verified", async () => {
      const error = await rejection(launch.assertPrivilegedSocketSession({ hm: true, jti: "j1" }));
      expect(error).toMatchObject({ statusCode: 503, code: "authorization_unavailable" });
    });
  });

  describe("browser binding cookie", () => {
    test("is HttpOnly, secure and usable inside the embedding frame", () => {
      const res = { cookie: jest.fn() };
      launch.setLaunchBrowserCookie(res, NONCE);
      const [name, value, options] = res.cookie.mock.calls[0];
      expect(name).toBe("hm_launch_browser");
      expect(value).toBe(NONCE);
      expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "none" });
    });

    test("is read back from a request's cookie header", () => {
      const req = { headers: { cookie: `other=1; hm_launch_browser=${NONCE}` } };
      expect(launch.readLaunchBrowserCookie(req)).toBe(NONCE);
      expect(launch.readLaunchBrowserCookie({ headers: {} })).toBeNull();
    });
  });

  describe("comparisons and origins", () => {
    test("secret comparison is exact", () => {
      expect(launch.timingSafeEqual("abc", "abc")).toBe(true);
      expect(launch.timingSafeEqual("abc", "abd")).toBe(false);
      expect(launch.timingSafeEqual("abc", "abcd")).toBe(false);
    });

    test("a wildcard origin never matches the configured parent", () => {
      expect(() => launch.assertParentOrigin("https://*.example.com")).toThrow(
        expect.objectContaining({ statusCode: 403, code: "origin_mismatch" }),
      );
      expect(() => launch.assertParentOrigin(ORIGIN)).not.toThrow();
    });

    test("only exact https origins are accepted", () => {
      expect(launch.isExactHttpsOrigin(ORIGIN)).toBe(true);
      for (const bad of ["http://x.com", "https://x.com/a", "https://u:p@x.com", "", undefined]) {
        expect(launch.isExactHttpsOrigin(bad)).toBe(false);
      }
    });
  });
});

describe("signed launch records", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.JWT_SECRET = "j".repeat(64);
    delete process.env.HEADMASTER_LAUNCH_HMAC_KEY;
  });

  afterAll(() => {
    process.env = saved;
  });

  test("round-trips a record under the key it was sealed for", () => {
    const sealed = launch.sealRecord("hm:code:abc", { g: "user-1", u: "nora-1" });
    expect(launch.openRecord("hm:code:abc", sealed)).toEqual({ g: "user-1", u: "nora-1" });
  });

  test("refuses a plain JSON record written straight into Redis", () => {
    const forged = JSON.stringify({ g: "user-1", u: "nora-1", o: ORIGIN });
    expect(launch.openRecord("hm:code:abc", forged)).toBeNull();
  });

  test("refuses a sealed record copied to another key", () => {
    const sealed = launch.sealRecord("hm:code:abc", { g: "user-1" });
    expect(launch.openRecord("hm:code:def", sealed)).toBeNull();
  });

  test("refuses a record whose body was edited", () => {
    const envelope = JSON.parse(launch.sealRecord("hm:sess:j1", { u: "nora-1" }));
    envelope.b = JSON.stringify({ u: "nora-2" });
    expect(launch.openRecord("hm:sess:j1", JSON.stringify(envelope))).toBeNull();
  });

  test("refuses a record sealed with a different signing key", () => {
    const sealed = launch.sealRecord("hm:sess:j1", { u: "nora-1" });
    process.env.HEADMASTER_LAUNCH_HMAC_KEY = "k".repeat(40);
    expect(launch.openRecord("hm:sess:j1", sealed)).toBeNull();
  });

  test("refuses garbage and empty values", () => {
    expect(launch.openRecord("hm:sess:j1", "not json")).toBeNull();
    expect(launch.openRecord("hm:sess:j1", null)).toBeNull();
    expect(launch.openRecord("hm:sess:j1", "{}")).toBeNull();
  });

  test("cannot seal when no signing key is configured", () => {
    delete process.env.JWT_SECRET;
    expect(() => launch.sealRecord("hm:sess:j1", {})).toThrow(/signing key/i);
  });

  test("refuses a too-short dedicated key", () => {
    process.env.HEADMASTER_LAUNCH_HMAC_KEY = "short";
    expect(() => launch.sealRecord("hm:sess:j1", {})).toThrow(/too short/);
  });
});
