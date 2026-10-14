// Route suites mock `db` with ordered query results and sign bare test tokens,
// so the per-request session_version lookup would consume their mocks.
// Server-side revocation has its own suite (sessionRevocation.test.ts), which
// opts back into the real check with jest.unmock("../sessionVersion").
jest.mock("../../sessionVersion", () => {
  const actual = jest.requireActual("../../sessionVersion");
  return { ...actual, checkSession: async () => ({ ok: true }) };
});
