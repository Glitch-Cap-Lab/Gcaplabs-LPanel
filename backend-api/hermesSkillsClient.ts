// @ts-nocheck
// Client for the Hermes skills registry. Unlike ClawHub's paged REST API, the
// Hermes hub publishes one aggregated index document (~35MB, ~90k entries) that
// the hermes CLI itself downloads and caches. This client mirrors that model:
// fetch the whole index, cache it on disk under os.tmpdir() plus in memory with
// a TTL, and serve list/search/detail queries from the cached copy. When a
// refresh fails and a cached copy exists, the cached copy is served with
// `stale: true` instead of failing the browse surface.
const fs = require("fs");
const os = require("os");
const path = require("path");

// Same hosted copy HeadmasterCore reads (hermes_cli/headmaster_nous.py HUB_BASE_URL),
// overridable with the same HEADMASTER_SKILLS_INDEX_URL variable.
const DEFAULT_HERMES_SKILLS_INDEX_URL = "https://downloads.gcaplabs.com/hub/skills-index.json";
const INDEX_CACHE_FILENAME = "nora-hermes-skills-index.json";
const DEFAULT_INDEX_TTL_MS = 3600000;
const INDEX_FETCH_TIMEOUT_MS = 30000;

function createHermesSkillsError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeText(value, fallback = "") {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      return trimmed ? [trimmed] : [];
    }
    if (typeof entry === "number" && Number.isFinite(entry)) {
      return [String(entry)];
    }
    return [];
  });
}

function resolveIndexUrl() {
  const override =
    normalizeText(process.env.HEADMASTER_SKILLS_INDEX_URL) ||
    normalizeText(process.env.HERMES_SKILLS_REGISTRY_URL);
  return override || DEFAULT_HERMES_SKILLS_INDEX_URL;
}

function resolveIndexTtlMs() {
  const parsed = Number.parseInt(process.env.HERMES_SKILLS_INDEX_TTL_MS, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_INDEX_TTL_MS;
}

// Resolved lazily so tests can point os.tmpdir() at an isolated directory.
function getIndexCachePath() {
  return path.join(os.tmpdir(), INDEX_CACHE_FILENAME);
}

// Skill identity in the index is the `identifier` field (e.g.
// "official/security/1password"); it doubles as Nora's install ref.

function normalizeSkillSummary(entry = {}) {
  const ref = normalizeText(entry?.identifier);
  if (!ref) return null;

  return {
    ref,
    name: normalizeText(entry?.name, ref),
    description: normalizeText(entry?.description),
    source: normalizeText(entry?.source),
    trustLevel: normalizeText(entry?.trust_level ?? entry?.trustLevel),
    tags: normalizeStringArray(entry?.tags),
  };
}

function normalizeSkillDetail(entry = {}) {
  const summary = normalizeSkillSummary(entry);
  if (!summary) return null;

  return {
    ...summary,
    repo: normalizeText(entry?.repo),
    path: normalizeText(entry?.path),
    extra: entry?.extra && typeof entry.extra === "object" ? entry.extra : null,
  };
}

// Index cache (in-memory copy + shared disk copy)

let memoryCache = null; // { url, fetchedAt, entries } — entries are raw index rows.

function filterIndexEntries(rawSkills) {
  if (!Array.isArray(rawSkills)) return [];
  // Filter once at cache time so cursor offsets stay stable across pages.
  return rawSkills.filter(
    (entry) => entry && typeof entry === "object" && normalizeText(entry.identifier),
  );
}

function readDiskCache(url) {
  try {
    const parsed = JSON.parse(fs.readFileSync(getIndexCachePath(), "utf8"));
    const fetchedAt = Number(parsed?.fetchedAt);
    // A cache written for another registry URL never satisfies this one.
    if (parsed?.url !== url || !Array.isArray(parsed?.skills) || !Number.isFinite(fetchedAt)) {
      return null;
    }
    return { url, fetchedAt, entries: filterIndexEntries(parsed.skills) };
  } catch {
    return null;
  }
}

function writeDiskCache(cache) {
  // Best-effort: a broken disk cache only costs a refetch. Write-then-rename
  // keeps concurrent readers from parsing a partially written 35MB file.
  const cachePath = getIndexCachePath();
  const tempPath = `${cachePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(
      tempPath,
      JSON.stringify({ url: cache.url, fetchedAt: cache.fetchedAt, skills: cache.entries }),
    );
    fs.renameSync(tempPath, cachePath);
  } catch {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* already gone */
    }
  }
}

async function fetchIndex(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal:
      typeof AbortSignal?.timeout === "function"
        ? AbortSignal.timeout(INDEX_FETCH_TIMEOUT_MS)
        : undefined,
  });
  if (!response || !response.ok) {
    throw new Error(`Unexpected registry response status ${response?.status}`);
  }
  const body = typeof response.text === "function" ? await response.text() : "";
  return JSON.parse(body);
}

/**
 * Load the skills index, preferring the freshest available copy: in-memory,
 * then disk, then a registry fetch. A failed fetch downgrades to any cached
 * copy (marked stale) so browse keeps working through registry outages.
 *
 * @returns {Promise<{entries: Array<object>, stale: boolean}>} Raw index rows.
 */
async function loadIndex() {
  const url = resolveIndexUrl();
  const ttlMs = resolveIndexTtlMs();
  const now = Date.now();

  if (memoryCache && memoryCache.url === url && now - memoryCache.fetchedAt < ttlMs) {
    return { entries: memoryCache.entries, stale: false };
  }

  if (!memoryCache || memoryCache.url !== url) {
    const diskCache = readDiskCache(url);
    if (diskCache) {
      memoryCache = diskCache;
      if (now - diskCache.fetchedAt < ttlMs) {
        return { entries: diskCache.entries, stale: false };
      }
    }
  }

  try {
    const payload = await fetchIndex(url);
    memoryCache = { url, fetchedAt: Date.now(), entries: filterIndexEntries(payload?.skills) };
    writeDiskCache(memoryCache);
    return { entries: memoryCache.entries, stale: false };
  } catch {
    if (memoryCache && memoryCache.url === url) {
      return { entries: memoryCache.entries, stale: true };
    }
    throw createHermesSkillsError(
      502,
      "hermes_registry_unavailable",
      "Could not reach the Hermes skills registry.",
    );
  }
}

// Public skill queries

function normalizeLimit(limit, fallback = 50) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function parseCursor(cursor) {
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Page through the cached index. The cursor is a plain numeric offset into the
 * filtered index (the index has no server-side pagination to delegate to).
 *
 * @param {Object} [options] - `limit` page size and `cursor` offset string.
 * @returns {Promise<Object>} `{ skills, nextCursor, stale }`.
 */
async function listSkills({ limit = 50, cursor = null } = {}) {
  const { entries, stale } = await loadIndex();
  const pageSize = normalizeLimit(limit);
  const offset = parseCursor(cursor);

  const page = entries.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;

  return {
    skills: page.map((entry) => normalizeSkillSummary(entry)).filter(Boolean),
    nextCursor: nextOffset < entries.length ? String(nextOffset) : null,
    stale,
  };
}

/**
 * Case-insensitive substring search over name, description, tags, and the
 * install identifier, evaluated against the cached index.
 *
 * @param {Object} [options] - `q` query text and `limit` result cap.
 * @returns {Promise<Object>} `{ skills, stale }`.
 */
async function searchSkills({ q, limit = 50 } = {}) {
  const query = normalizeText(q).toLowerCase();
  if (!query) {
    throw createHermesSkillsError(400, "missing_query", "q is required.");
  }

  const { entries, stale } = await loadIndex();
  const resultCap = normalizeLimit(limit);
  const skills = [];

  for (const entry of entries) {
    const haystack = [
      normalizeText(entry?.name),
      normalizeText(entry?.description),
      normalizeText(entry?.identifier),
      ...normalizeStringArray(entry?.tags),
    ]
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(query)) continue;

    const summary = normalizeSkillSummary(entry);
    if (!summary) continue;
    skills.push(summary);
    if (skills.length >= resultCap) break;
  }

  return { skills, stale };
}

/**
 * Resolve one skill by its exact index identifier and return the full index
 * entry (summary fields plus repo/path/extra).
 *
 * @param {string} ref - Registry identifier, e.g. `official/security/1password`.
 * @returns {Promise<Object>} Normalized detail with a `stale` marker.
 */
async function getSkillDetail(ref) {
  const normalizedRef = normalizeText(ref);
  if (!normalizedRef) {
    throw createHermesSkillsError(404, "skill_not_found", "No skill found with ref: unknown");
  }

  const { entries, stale } = await loadIndex();
  const entry = entries.find((candidate) => normalizeText(candidate?.identifier) === normalizedRef);
  const detail = entry ? normalizeSkillDetail(entry) : null;
  if (!detail) {
    throw createHermesSkillsError(
      404,
      "skill_not_found",
      `No skill found with ref: ${normalizedRef}`,
    );
  }

  return { ...detail, stale };
}

function __resetCacheForTests({ keepDisk = false } = {}) {
  memoryCache = null;
  if (keepDisk) return;
  try {
    fs.unlinkSync(getIndexCachePath());
  } catch {
    /* no disk cache to remove */
  }
}

module.exports = {
  DEFAULT_HERMES_SKILLS_INDEX_URL,
  __resetCacheForTests,
  createHermesSkillsError,
  getIndexCachePath,
  getSkillDetail,
  listSkills,
  normalizeSkillDetail,
  normalizeSkillSummary,
  searchSkills,
};
