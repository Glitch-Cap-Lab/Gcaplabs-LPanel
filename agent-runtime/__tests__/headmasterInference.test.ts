import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "tsx/cjs";

const headmasterInference = require("../lib/headmasterInference.ts");
const hermesRuntimeBootstrap = require("../lib/hermesRuntimeBootstrap.ts");

const {
  HEADMASTER_DEFAULT_TIER,
  HEADMASTER_INFERENCE_DEFAULT_BASE_URL,
  HEADMASTER_INFERENCE_KEY_REF,
  HEADMASTER_PROVIDER_ID,
  HEADMASTER_TIER_MODELS,
  buildHeadmasterModelConfig,
  buildHeadmasterProviderEntry,
  buildHeadmasterProviderRow,
  deriveHeadmasterInferenceKey,
  headmasterInferenceBaseUrl,
  headmasterInferenceContainerEnv,
} = headmasterInference;
const { buildHermesRuntimeBootstrapEnv, buildHermesRuntimeConfigBootstrapCommand } =
  hermesRuntimeBootstrap;

describe("Headmaster tier definition", () => {
  it("is exactly Lite, Pro and Max in that order", () => {
    // The desktop (apps/desktop/electron/headmaster-trial-provider.ts) and the
    // relay (services/headmaster-inference/policy.mjs) carry the same three ids.
    expect([...HEADMASTER_TIER_MODELS]).toEqual(["headmaster-lite", "headmaster-pro"]);
    expect(HEADMASTER_DEFAULT_TIER).toBe("headmaster-lite");
  });

  it("registers the tiers as a fixed list with no live discovery and no inline credential", () => {
    const entry = buildHeadmasterProviderEntry({});
    expect(entry.name).toBe("Headmaster");
    expect(entry.discover_models).toBe(false);
    expect(Object.keys(entry.models)).toEqual([...HEADMASTER_TIER_MODELS]);
    expect(entry.key_env).toBe("HEADMASTER_INFERENCE_KEY");
    expect(entry).not.toHaveProperty("api_key");
    expect(entry.base_url).toBe(HEADMASTER_INFERENCE_DEFAULT_BASE_URL);
  });

  it("points the main model at the provider by env reference, never a literal key", () => {
    const config = buildHeadmasterModelConfig({});
    expect(config).toMatchObject({
      provider: HEADMASTER_PROVIDER_ID,
      defaultModel: "headmaster-lite",
      apiKey: HEADMASTER_INFERENCE_KEY_REF,
    });
    expect(JSON.stringify(config)).not.toMatch(/[0-9a-f]{64}/);
    expect(buildHeadmasterProviderRow({}).provider).toBe(HEADMASTER_PROVIDER_ID);
  });
});

describe("relay endpoint and credential", () => {
  it("derives a stable key that differs from the gateway key", () => {
    const key = deriveHeadmasterInferenceKey("gateway-key");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(deriveHeadmasterInferenceKey("gateway-key"));
    expect(key).not.toBe(deriveHeadmasterInferenceKey("other-gateway-key"));
    expect(key).not.toBe("gateway-key");
    expect(() => deriveHeadmasterInferenceKey("")).toThrow();
  });

  it("accepts only a plain https base URL override", () => {
    expect(
      headmasterInferenceBaseUrl({ HEADMASTER_INFERENCE_BASE_URL: "https://relay.example/v1/" }),
    ).toBe("https://relay.example/v1");
    for (const bad of [
      "http://relay.example/v1",
      "https://u:p@relay.example/v1",
      "https://r.example/v1?x=1",
      "nonsense",
    ]) {
      expect(() => headmasterInferenceBaseUrl({ HEADMASTER_INFERENCE_BASE_URL: bad })).toThrow();
    }
  });

  it("gives the container the derived key and the endpoint", () => {
    expect(headmasterInferenceContainerEnv("gateway-key", {})).toEqual({
      HEADMASTER_INFERENCE_KEY: deriveHeadmasterInferenceKey("gateway-key"),
      HEADMASTER_INFERENCE_BASE_URL: HEADMASTER_INFERENCE_DEFAULT_BASE_URL,
    });
  });
});

// Runs the real bootstrap script under sh against a stand-in for hermes_cli.config
// that keeps the config as JSON, so the model block it writes can be read back.
describe("container bootstrap writes the managed model block", () => {
  let home: string;
  let stub: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "headmaster-bootstrap-"));
    stub = mkdtempSync(join(tmpdir(), "headmaster-stub-"));
    mkdirSync(join(stub, "hermes_cli"));
    writeFileSync(join(stub, "hermes_cli", "__init__.py"), "");
    writeFileSync(
      join(stub, "hermes_cli", "config.py"),
      [
        "import json, os",
        "from pathlib import Path",
        "def get_config_path():",
        '    return Path(os.environ["HERMES_HOME"]) / "config.json"',
        "def load_config():",
        "    path = get_config_path()",
        "    return json.loads(path.read_text()) if path.exists() else {}",
        "def save_config(config):",
        "    get_config_path().write_text(json.dumps(config))",
        "",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(stub, { recursive: true, force: true });
  });

  function runBootstrap(modelConfig: object, existing?: object) {
    if (existing) writeFileSync(join(home, "config.json"), JSON.stringify(existing));
    const env = buildHermesRuntimeBootstrapEnv({ modelConfig });
    const result = spawnSync("sh", ["-c", buildHermesRuntimeConfigBootstrapCommand()], {
      env: { PATH: process.env.PATH, HERMES_HOME: home, PYTHONPATH: stub, ...env },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  }

  it("seeds a fresh runtime with the provider entry and the default tier", () => {
    const config = runBootstrap(buildHeadmasterModelConfig({}));
    expect(config.model).toEqual({
      provider: "headmaster",
      default: "headmaster-lite",
      base_url: HEADMASTER_INFERENCE_DEFAULT_BASE_URL,
      api_key: HEADMASTER_INFERENCE_KEY_REF,
    });
    expect(config.providers.headmaster.discover_models).toBe(false);
    expect(Object.keys(config.providers.headmaster.models)).toEqual([...HEADMASTER_TIER_MODELS]);
    expect(config.providers.headmaster.key_env).toBe("HEADMASTER_INFERENCE_KEY");
  });

  it("replaces an operator provider left in the config by an older image", () => {
    const config = runBootstrap(buildHeadmasterModelConfig({}), {
      model: { provider: "openrouter", default: "some/model", api_key: "sk-operator-secret" },
      memory: { provider: "hindsight" },
    });
    expect(config.model.provider).toBe("headmaster");
    expect(JSON.stringify(config)).not.toContain("sk-operator-secret");
    expect(config.memory).toEqual({ provider: "hindsight" });
  });

  it("keeps the tier the user already chose", () => {
    const config = runBootstrap(buildHeadmasterModelConfig({}), {
      model: { provider: "headmaster", default: "headmaster-pro" },
    });
    expect(config.model.default).toBe("headmaster-pro");
  });

  it("resets a retired Max choice to the managed default", () => {
    const config = runBootstrap(buildHeadmasterModelConfig({}), {
      model: { provider: "headmaster", default: "headmaster-max" },
    });
    expect(config.model.default).toBe("headmaster-lite");
  });

  it("keeps every other provider entry, including personal-key entries, across a restart", () => {
    const own = {
      name: "Your OpenAI key",
      base_url: `${HEADMASTER_INFERENCE_DEFAULT_BASE_URL}/own/openai`,
      key_env: "HEADMASTER_INFERENCE_KEY",
      discover_models: true,
    };
    const local = { name: "Local", base_url: "http://127.0.0.1:1234/v1" };
    const config = runBootstrap(buildHeadmasterModelConfig({}), {
      model: { provider: "headmaster", default: "headmaster-pro" },
      providers: {
        headmaster: { name: "stale", base_url: "https://old.example/v1" },
        "headmaster-own-openai": own,
        "my-local": local,
      },
    });
    expect(config.providers["headmaster-own-openai"]).toEqual(own);
    expect(config.providers["my-local"]).toEqual(local);
    expect(config.providers.headmaster.name).toBe("Headmaster");
    expect(config.model.default).toBe("headmaster-pro");
  });

  it("keeps a model the owner picked from their personal-key provider while that entry exists", () => {
    const own = {
      name: "Your OpenAI key",
      base_url: `${HEADMASTER_INFERENCE_DEFAULT_BASE_URL}/own/openai`,
      key_env: "HEADMASTER_INFERENCE_KEY",
      discover_models: true,
    };
    const chosen = {
      provider: "headmaster-own-openai",
      default: "gpt-x",
      base_url: own.base_url,
      key_env: "HEADMASTER_INFERENCE_KEY",
    };
    const kept = runBootstrap(buildHeadmasterModelConfig({}), {
      model: chosen,
      providers: { "headmaster-own-openai": own },
    });
    expect(kept.model).toEqual(chosen);
    expect(kept.providers["headmaster-own-openai"]).toEqual(own);
    expect(kept.providers.headmaster.key_env).toBe("HEADMASTER_INFERENCE_KEY");

    // The entry moved to another inference host: the stale model is not kept.
    const moved = runBootstrap(buildHeadmasterModelConfig({}), {
      model: chosen,
      providers: {
        "headmaster-own-openai": { ...own, base_url: "https://other.example/v1/own/openai" },
      },
    });
    expect(moved.model.provider).toBe("headmaster");
    expect(moved.model.base_url).toBe(HEADMASTER_INFERENCE_DEFAULT_BASE_URL);

    // A different credential reference is not kept either; the api_key form of the same reference is.
    const otherKey = runBootstrap(buildHeadmasterModelConfig({}), {
      model: { ...chosen, key_env: "SOMETHING_ELSE" },
      providers: { "headmaster-own-openai": own },
    });
    expect(otherKey.model.provider).toBe("headmaster");
    const viaApiKey = runBootstrap(buildHeadmasterModelConfig({}), {
      model: {
        provider: chosen.provider,
        default: "gpt-x",
        base_url: `${own.base_url}/`,
        api_key: HEADMASTER_INFERENCE_KEY_REF,
      },
      providers: { "headmaster-own-openai": own },
    });
    expect(viaApiKey.model.provider).toBe("headmaster-own-openai");

    // An entry that names any credential variable other than the derived inference key is not trusted,
    // even when the model repeats the same name.
    const foreign = { ...own, key_env: "OPERATOR_SECRET_KEY" };
    const foreignKept = runBootstrap(buildHeadmasterModelConfig({}), {
      model: { ...chosen, key_env: "OPERATOR_SECRET_KEY" },
      providers: { "headmaster-own-openai": foreign },
    });
    expect(foreignKept.model.provider).toBe("headmaster");
    expect(foreignKept.model.key_env).toBeUndefined();

    // The entry is gone (key removed, or a fresh volume before admission re-syncs): back to managed.
    const replaced = runBootstrap(buildHeadmasterModelConfig({}), { model: chosen });
    expect(replaced.model.provider).toBe("headmaster");
    expect(replaced.model.default).toBe("headmaster-lite");
    expect(replaced.model.api_key).toBe(HEADMASTER_INFERENCE_KEY_REF);
  });

  it("leaves other providers' generic model blocks working as before", () => {
    const config = runBootstrap({
      provider: "custom",
      defaultModel: "local-model",
      baseUrl: "https://models.example/v1",
      apiKey: "user-key",
    });
    expect(config.model).toEqual({
      provider: "custom",
      default: "local-model",
      base_url: "https://models.example/v1",
      api_key: "user-key",
    });
    expect(config).not.toHaveProperty("providers");
  });
});

describe("headmasterInferenceBaseUrl memoization", () => {
  it("re-reads when the env value changes and skips re-parsing when unchanged", () => {
    const URLCtor = global.URL;
    const spy = vi.fn();
    global.URL = class extends URLCtor {
      constructor(...args) {
        super(...args);
        spy(...args);
      }
    };
    try {
      const a = { HEADMASTER_INFERENCE_BASE_URL: "https://memo-a.example/v1/" };
      expect(headmasterInferenceBaseUrl(a)).toBe("https://memo-a.example/v1");
      const calls = spy.mock.calls.length;
      expect(headmasterInferenceBaseUrl({ ...a })).toBe("https://memo-a.example/v1");
      expect(spy.mock.calls.length).toBe(calls);
      expect(
        headmasterInferenceBaseUrl({ HEADMASTER_INFERENCE_BASE_URL: "https://memo-b.example/v1" }),
      ).toBe("https://memo-b.example/v1");
      expect(spy.mock.calls.length).toBeGreaterThan(calls);
    } finally {
      global.URL = URLCtor;
    }
  });

  it("does not cache invalid values", () => {
    const bad = { HEADMASTER_INFERENCE_BASE_URL: "http://insecure.example" };
    expect(() => headmasterInferenceBaseUrl(bad)).toThrow();
    expect(() => headmasterInferenceBaseUrl(bad)).toThrow();
  });
});
