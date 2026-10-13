// @ts-nocheck
describe("crypto startup guard", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    jest.resetModules();
  });

  it("refuses to load in production without a valid ENCRYPTION_KEY", () => {
    process.env.NODE_ENV = "production";
    process.env.ENCRYPTION_KEY = "";
    expect(() => jest.isolateModules(() => require("../crypto"))).toThrow(/ENCRYPTION_KEY/);
  });

  it("loads in production with a valid key", () => {
    process.env.NODE_ENV = "production";
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    jest.isolateModules(() => {
      expect(require("../crypto").isEncryptionConfigured()).toBe(true);
    });
  });

  it("only warns outside production", () => {
    process.env.NODE_ENV = "test";
    process.env.ENCRYPTION_KEY = "";
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.isolateModules(() => {
      expect(require("../crypto").isEncryptionConfigured()).toBe(false);
    });
    spy.mockRestore();
  });
});
