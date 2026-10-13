// @ts-nocheck
const { isAdminSurfaceEnabled, enabledAdminSurfaces, requireAdminSurfaceEnabled } = require("../middleware/backendGate");

describe("optional admin surface gate", () => {
  const saved = process.env.ADMIN_OPTIONAL_SURFACES;
  afterEach(() => {
    if (saved === undefined) delete process.env.ADMIN_OPTIONAL_SURFACES;
    else process.env.ADMIN_OPTIONAL_SURFACES = saved;
  });

  it("is off by default", () => {
    expect(enabledAdminSurfaces({})).toEqual([]);
    expect(isAdminSurfaceEnabled("agent-hub", {})).toBe(false);
  });

  it("accepts known surfaces only", () => {
    expect(enabledAdminSurfaces({ ADMIN_OPTIONAL_SURFACES: " Queue,backups,bogus" })).toEqual(["queue", "backups"]);
  });

  it("answers 404 when off and continues when on", () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    delete process.env.ADMIN_OPTIONAL_SURFACES;
    requireAdminSurfaceEnabled("members")({}, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
    process.env.ADMIN_OPTIONAL_SURFACES = "members";
    requireAdminSurfaceEnabled("members")({}, res, next);
    expect(next).toHaveBeenCalled();
  });
});
