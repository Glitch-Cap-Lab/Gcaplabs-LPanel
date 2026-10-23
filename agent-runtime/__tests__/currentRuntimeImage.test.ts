import { afterEach, describe, expect, it, vi } from "vitest";
import "tsx/cjs";

const current = require("../lib/currentRuntimeImage.ts");
const { getHermesDockerAgentImage, getDefaultAgentImage } = require("../lib/agentImages.ts");

const env = { HEADMASTER_SUPABASE_URL: "https://acct.test/", HEADMASTER_SUPABASE_SERVICE_ROLE_KEY: "svc" };
const reply = (body: unknown, ok = true) => vi.fn().mockResolvedValue({ ok, json: async () => body });

afterEach(() => {
  current.resetCurrentRuntimeImageForTests();
  delete process.env.HERMES_DOCKER_IMAGE;
});

describe("current runtime image", () => {
  it("is used for new Hermes bots, with the env image as the fallback", async () => {
    process.env.HERMES_DOCKER_IMAGE = "hm:old";
    expect(getHermesDockerAgentImage()).toBe("hm:old");
    const fetchImpl = reply("hm:new");
    await current.refreshCurrentRuntimeImage({ env, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://acct.test/rest/v1/rpc/headmaster_current_runtime_image");
    expect(getHermesDockerAgentImage()).toBe("hm:new");
    expect(getDefaultAgentImage({ runtime_family: "hermes", deploy_target: "docker" })).toBe("hm:new");
  });

  it("falls back to the env image when there is no release, no config or a failing account database", async () => {
    process.env.HERMES_DOCKER_IMAGE = "hm:old";
    await current.refreshCurrentRuntimeImage({ env, fetchImpl: reply(null) });
    expect(getHermesDockerAgentImage()).toBe("hm:old");
    await current.refreshCurrentRuntimeImage({ env: {}, fetchImpl: reply("hm:new") });
    expect(getHermesDockerAgentImage()).toBe("hm:old");
    await current.refreshCurrentRuntimeImage({ env, fetchImpl: reply("hm:new", false) });
    expect(getHermesDockerAgentImage()).toBe("hm:old");
    await current.refreshCurrentRuntimeImage({ env, fetchImpl: vi.fn().mockRejectedValue(new Error("down")) });
    expect(getHermesDockerAgentImage()).toBe("hm:old");
  });

  it("keeps the last answer when a refresh fails, and refuses a malformed image name", async () => {
    await current.refreshCurrentRuntimeImage({ env, fetchImpl: reply("hm:new") });
    await current.refreshCurrentRuntimeImage({ env, fetchImpl: vi.fn().mockRejectedValue(new Error("down")) });
    expect(current.getCurrentRuntimeImage()).toBe("hm:new");
    await current.refreshCurrentRuntimeImage({ env, fetchImpl: reply("bad image; rm -rf") });
    expect(current.getCurrentRuntimeImage()).toBeNull();
  });
});
