// @ts-nocheck
jest.mock("../db", () => ({ query: jest.fn() }));
const { parseRevalidateSeconds } = require("../headmasterLaunch");

describe("parseRevalidateSeconds", () => {
  test("accepts 120", () => expect(parseRevalidateSeconds("120")).toBe(120));
  test("clamps above the maximum to 120", () => expect(parseRevalidateSeconds("500")).toBe(120));
  test("clamps below the minimum to 10", () => expect(parseRevalidateSeconds("5")).toBe(10));
  test("falls back to the default when unset or invalid", () => {
    expect(parseRevalidateSeconds(undefined)).toBe(25);
    expect(parseRevalidateSeconds("abc")).toBe(25);
  });
});
