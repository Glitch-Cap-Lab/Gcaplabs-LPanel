const { redisAuthProblem, enforceRedisAuth } = require("../lib/connectionConfig");

describe("Redis authentication", () => {
  const quiet = () => ({ error: jest.fn(), warn: jest.fn() });

  test("an open bundled Redis is a problem; a password or external URL is not", () => {
    expect(redisAuthProblem({})).toMatch(/unauthenticated/);
    expect(redisAuthProblem({ REDIS_PASSWORD: "  " })).toMatch(/unauthenticated/);
    expect(redisAuthProblem({ REDIS_PASSWORD: "secret" })).toBe("");
    expect(redisAuthProblem({ REDIS_URL: "rediss://user:pw@cache.example.com:6380" })).toBe("");
  });

  test("refuses to boot when authentication is required and missing", () => {
    const log = quiet();
    const exit = jest.fn();
    enforceRedisAuth({ NORA_REQUIRE_REDIS_AUTH: "true" }, log, exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error).toHaveBeenCalled();
  });

  test("only warns in production when authentication is not required", () => {
    const log = quiet();
    const exit = jest.fn();
    enforceRedisAuth({ NODE_ENV: "production" }, log, exit);
    expect(exit).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  test("stays quiet when a password is set", () => {
    const log = quiet();
    const exit = jest.fn();
    enforceRedisAuth({ NODE_ENV: "production", NORA_REQUIRE_REDIS_AUTH: "true", REDIS_PASSWORD: "pw" }, log, exit);
    expect(exit).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
