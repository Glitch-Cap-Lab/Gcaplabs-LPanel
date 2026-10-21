// @ts-nocheck
const crypto = require("crypto");

// Built-in "headmaster" model provider for Headmaster-managed Hermes runtimes.
//
// A Cloud runtime reaches Headmaster's managed inference relay the same way the
// desktop's Work engine does: one named provider with three fixed tiers and no
// model discovery. Nothing operator-owned is copied into the container. The
// runtime authenticates with a key derived from its own API_SERVER_KEY, admission
// resolves that key back to the owner through the runtime-identity route, and
// the relay selects the operator-owned provider key server-side.
//
// Shared by backend-api (model config, identity route) and the provisioner
// (container env); mounted read-only like the other agent-runtime contracts.
//
// Keep HEADMASTER_TIER_MODELS equal to the desktop's list in
// apps/desktop/electron/headmaster-trial-provider.ts and to the relay's
// services/headmaster-inference/policy.mjs; headmasterInference.test.ts pins
// the values.

const HEADMASTER_PROVIDER_ID = "headmaster";
const HEADMASTER_PROVIDER_LABEL = "Headmaster";
const HEADMASTER_TIER_MODELS = Object.freeze(["headmaster-lite", "headmaster-pro"]);
const HEADMASTER_DEFAULT_TIER = HEADMASTER_TIER_MODELS[0];
const HEADMASTER_MANAGED_MARKER = "headmaster";
const HEADMASTER_INFERENCE_KEY_ENV = "HEADMASTER_INFERENCE_KEY";
const HEADMASTER_INFERENCE_KEY_REF = `\${${HEADMASTER_INFERENCE_KEY_ENV}}`;
const HEADMASTER_INFERENCE_DEFAULT_BASE_URL = "https://inference.gcaplabs.com/v1";
const INFERENCE_KEY_LABEL = "headmaster-inference-v1";
const HEX_64 = /^[0-9a-f]{64}$/i;

/**
 * Derive the runtime's inference credential from its API_SERVER_KEY. It is a
 * separate value so a leaked inference key cannot drive the runtime's own
 * gateway or memory paths, and it is deterministic so the container env and the
 * identity route always agree without persisted state.
 *
 * @param {string} apiServerKey - The runtime's gateway key.
 * @returns {string} 64-character lowercase hex credential.
 */
function deriveHeadmasterInferenceKey(apiServerKey) {
  if (typeof apiServerKey !== "string" || apiServerKey.length === 0) {
    throw new Error("deriveHeadmasterInferenceKey requires a non-empty string key");
  }
  return crypto.createHmac("sha256", apiServerKey).update(INFERENCE_KEY_LABEL).digest("hex");
}

let baseUrlCache = { raw: null, result: null };

/**
 * Resolve the relay base URL as reachable from a runtime container.
 *
 * @param {Object} [env=process.env] - Environment holding HEADMASTER_INFERENCE_BASE_URL.
 * @returns {string} HTTPS base URL without a trailing slash.
 */
function headmasterInferenceBaseUrl(env = process.env) {
  const raw = String(env?.HEADMASTER_INFERENCE_BASE_URL || "").trim();
  // Memoize the validated result keyed on the raw string, so an env change is
  // still picked up. Only successes are cached; invalid values re-throw.
  if (raw === baseUrlCache.raw && baseUrlCache.result !== null) return baseUrlCache.result;
  const value = raw || HEADMASTER_INFERENCE_DEFAULT_BASE_URL;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("HEADMASTER_INFERENCE_BASE_URL must be an absolute https URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search) {
    throw new Error("HEADMASTER_INFERENCE_BASE_URL must be a plain https URL");
  }
  const result = value.replace(/\/+$/, "");
  baseUrlCache = { raw, result };
  return result;
}

/**
 * Container environment entries that let the runtime authenticate to the relay.
 *
 * @param {string} apiServerKey - The runtime's gateway key.
 * @param {Object} [env=process.env] - Environment holding the optional base URL override.
 * @returns {Object} Env entries for the container.
 */
function headmasterInferenceContainerEnv(apiServerKey, env = process.env) {
  return {
    [HEADMASTER_INFERENCE_KEY_ENV]: deriveHeadmasterInferenceKey(apiServerKey),
    HEADMASTER_INFERENCE_BASE_URL: headmasterInferenceBaseUrl(env),
  };
}

/**
 * Synthetic default-provider row for a Headmaster-managed runtime, shaped like
 * an `llm_providers` row so the existing model-config builders can consume it.
 *
 * @param {Object} [env=process.env] - Environment holding the optional base URL override.
 * @returns {Object} Provider row with the relay endpoint and default tier.
 */
function buildHeadmasterProviderRow(env = process.env) {
  return {
    id: null,
    provider: HEADMASTER_PROVIDER_ID,
    model: HEADMASTER_DEFAULT_TIER,
    config: { base_url: headmasterInferenceBaseUrl(env) },
  };
}

/**
 * Hermes model block for the managed provider. The key is an environment
 * reference, so config.yaml never holds the credential.
 *
 * @param {Object} [env=process.env] - Environment holding the optional base URL override.
 * @returns {Object} Model config in the shape the bootstrap writers accept.
 */
function buildHeadmasterModelConfig(env = process.env) {
  return {
    managed: HEADMASTER_MANAGED_MARKER,
    provider: HEADMASTER_PROVIDER_ID,
    defaultModel: HEADMASTER_DEFAULT_TIER,
    baseUrl: headmasterInferenceBaseUrl(env),
    apiKey: HEADMASTER_INFERENCE_KEY_REF,
    tiers: [...HEADMASTER_TIER_MODELS],
    providerEntry: buildHeadmasterProviderEntry(env),
  };
}

/**
 * The `providers.headmaster` entry the runtime lists in its model picker: the
 * three fixed tiers, no live model discovery, credential by environment name.
 *
 * @param {Object} [env=process.env] - Environment holding the optional base URL override.
 * @returns {Object} Provider entry for config.yaml.
 */
function buildHeadmasterProviderEntry(env = process.env) {
  return {
    name: HEADMASTER_PROVIDER_LABEL,
    base_url: headmasterInferenceBaseUrl(env),
    model: HEADMASTER_DEFAULT_TIER,
    discover_models: false,
    key_env: HEADMASTER_INFERENCE_KEY_ENV,
    models: Object.fromEntries(HEADMASTER_TIER_MODELS.map((tier) => [tier, {}])),
  };
}

// Python run inside the runtime, shared by every writer that applies the managed
// model block (container bootstrap, the provisioner's exec writer, and the
// adopt-time stamp) so the rule lives in one place. It takes the payload built
// by buildHeadmasterModelConfig(): register the provider entry with its fixed
// tiers, point the main model at it, and keep a tier the user already chose.
// Anything else in `model` (a foreign provider from an older image, an operator
// key) is replaced, except a choice of the owner's own personal-key provider
// entry (headmaster-own-*), which stays while that entry exists.
const HEADMASTER_APPLY_MODEL_PY = `
def apply_headmaster_model(config, payload):
    provider_id = str(payload.get("provider") or "").strip()
    tiers = [str(item) for item in (payload.get("tiers") or [])]
    entry = payload.get("providerEntry")
    if not provider_id or not isinstance(entry, dict):
        return False
    providers = config.get("providers")
    providers = dict(providers) if isinstance(providers, dict) else {}
    providers[provider_id] = entry
    config["providers"] = providers
    model = config.get("model")
    model = dict(model) if isinstance(model, dict) else {}
    # A model the owner picked from one of their personal-key providers
    # (providers.headmaster-own-<provider>, written server-side by admission) is
    # left exactly as it is while that entry exists. The entries themselves are
    # never touched here: only providers[provider_id] is written above.
    current_provider = str(model.get("provider") or "").strip()
    own_entry = providers.get(current_provider) if current_provider.startswith("headmaster-own-") else None
    if isinstance(own_entry, dict):
        # Keep the choice only while the model still points at that entry's
        # endpoint and credential; otherwise (inference host changed, entry
        # rewritten) fall through and reset to the managed default.
        # The only credential a personal-key entry may name is the runtime's own
        # derived inference key. Admission writes exactly that; an entry that
        # names any other variable (for example an operator secret) is not
        # trusted and the model is reset to the managed default.
        entry_key_env = str(own_entry.get("key_env") or "").strip()
        if entry_key_env != "HEADMASTER_INFERENCE_KEY":
            entry_key_env = ""
        same_url = str(model.get("base_url") or "").strip().rstrip("/") == str(own_entry.get("base_url") or "").strip().rstrip("/")
        key_env_ref = "\${" + entry_key_env + "}"
        same_key = bool(entry_key_env) and (
            str(model.get("key_env") or "").strip() == entry_key_env
            or str(model.get("api_key") or "").strip() == key_env_ref
        )
        if same_url and same_key:
            config["model"] = model
            return True
    keep_choice = model.get("provider") == provider_id and model.get("default") in tiers
    model["provider"] = provider_id
    model["base_url"] = str(payload.get("baseUrl") or "").strip()
    model["api_key"] = str(payload.get("apiKey") or "").strip()
    model.pop("key_env", None)
    if not keep_choice:
        model["default"] = str(payload.get("defaultModel") or "").strip()
    config["model"] = model
    return True
`;

function isHeadmasterInferenceKey(value) {
  return typeof value === "string" && HEX_64.test(value);
}

module.exports = {
  HEADMASTER_MANAGED_MARKER,
  HEADMASTER_APPLY_MODEL_PY,
  HEADMASTER_PROVIDER_ID,
  HEADMASTER_PROVIDER_LABEL,
  HEADMASTER_TIER_MODELS,
  HEADMASTER_DEFAULT_TIER,
  HEADMASTER_INFERENCE_KEY_ENV,
  HEADMASTER_INFERENCE_KEY_REF,
  HEADMASTER_INFERENCE_DEFAULT_BASE_URL,
  deriveHeadmasterInferenceKey,
  headmasterInferenceBaseUrl,
  headmasterInferenceContainerEnv,
  buildHeadmasterProviderRow,
  buildHeadmasterModelConfig,
  buildHeadmasterProviderEntry,
  isHeadmasterInferenceKey,
};
