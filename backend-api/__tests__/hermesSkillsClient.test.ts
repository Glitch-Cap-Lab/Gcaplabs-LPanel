// @ts-nocheck
const fs = require("fs");
const os = require("os");
const path = require("path");

// Point the client's os.tmpdir()-based disk cache at an isolated directory so
// parallel jest workers (and developer machines) never share cache files.
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nora-hermes-skills-client-test-"));
jest.spyOn(os, "tmpdir").mockReturnValue(CACHE_DIR);

const {
  DEFAULT_HERMES_SKILLS_INDEX_URL,
  __resetCacheForTests,
  getIndexCachePath,
  getSkillDetail,
  listSkills,
  normalizeSkillSummary,
  searchSkills,
} = require("../hermesSkillsClient");

const SKILL_FIXTURES = [
  {
    name: "1password",
    description: "Manage 1Password vaults.",
    source: "official",
    identifier: "official/security/1password",
    trust_level: "builtin",
    repo: "https://github.com/headmaster/skills",
    path: "security/1password",
    tags: ["security", "passwords"],
    extra: { verified: true },
  },
  {
    name: "k8s",
    description: "Operate Kubernetes clusters.",
    source: "clawhub",
    identifier: "openai/skills/k8s",
    trust_level: "community",
    repo: "https://github.com/openai/skills",
    path: "skills/k8s",
    tags: ["kubernetes", "infra"],
    extra: {},
  },
  {
    name: "notion",
    description: "Read and write Notion pages.",
    source: "skills.sh",
    identifier: "skills-sh/productivity/notion",
    trust_level: "trusted",
    repo: "https://github.com/skills-sh/notion",
    path: "productivity/notion",
    tags: ["productivity"],
    extra: {},
  },
];

function buildIndexPayload(skills = SKILL_FIXTURES) {
  return {
    version: 1,
    generated_at: "2026-07-01T00:00:00Z",
    skill_count: skills.length,
    skills,
  };
}

function mockJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  };
}

function mockTextResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(text),
  };
}

describe("hermesSkillsClient", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    __resetCacheForTests();
    delete process.env.HERMES_SKILLS_REGISTRY_URL;
    delete process.env.HEADMASTER_SKILLS_INDEX_URL;
    delete process.env.HERMES_SKILLS_INDEX_TTL_MS;
  });

  afterEach(() => {
    delete global.fetch;
  });

  describe("normalizeSkillSummary", () => {
    it("normalizes an index entry into the summary shape", () => {
      expect(normalizeSkillSummary(SKILL_FIXTURES[0])).toEqual({
        ref: "official/security/1password",
        name: "1password",
        description: "Manage 1Password vaults.",
        source: "official",
        trustLevel: "builtin",
        tags: ["security", "passwords"],
      });
    });

    it("falls back to the ref when the name is missing", () => {
      expect(normalizeSkillSummary({ identifier: "a/b/c" })).toEqual({
        ref: "a/b/c",
        name: "a/b/c",
        description: "",
        source: "",
        trustLevel: "",
        tags: [],
      });
    });

    it("returns null when no identifier can be derived", () => {
      expect(normalizeSkillSummary({})).toBeNull();
      expect(normalizeSkillSummary({ name: "no ref" })).toBeNull();
      expect(normalizeSkillSummary(null)).toBeNull();
    });
  });

  describe("index source", () => {
    it("reads the Core-hosted index and never contacts a vendor host", async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload()));
      await listSkills({ limit: 1 });
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls).toHaveLength(1);
      expect(urls[0]).toBe(DEFAULT_HERMES_SKILLS_INDEX_URL);
      expect(urls.join(" ")).not.toMatch(new RegExp(["nous", "research"].join(""), "i"));
    });

    it("prefers HEADMASTER_SKILLS_INDEX_URL when set", async () => {
      process.env.HEADMASTER_SKILLS_INDEX_URL = "https://mirror.example.com/skills-index.json";
      fetchMock.mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload()));
      await listSkills({ limit: 1 });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://mirror.example.com/skills-index.json",
        expect.any(Object),
      );
    });
  });

  describe("listSkills", () => {
    it("fetches the aggregated index and returns a normalized page", async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload()));

      const result = await listSkills({ limit: 2 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(DEFAULT_HERMES_SKILLS_INDEX_URL, expect.any(Object));
      expect(result).toEqual({
        skills: [
          {
            ref: "official/security/1password",
            name: "1password",
            description: "Manage 1Password vaults.",
            source: "official",
            trustLevel: "builtin",
            tags: ["security", "passwords"],
          },
          {
            ref: "openai/skills/k8s",
            name: "k8s",
            description: "Operate Kubernetes clusters.",
            source: "clawhub",
            trustLevel: "community",
            tags: ["kubernetes", "infra"],
          },
        ],
        nextCursor: "2",
        stale: false,
      });
    });

    it("serves later pages from the cache without refetching", async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload()));

      await listSkills({ limit: 2 });
      const secondPage = await listSkills({ limit: 2, cursor: "2" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(secondPage.skills).toHaveLength(1);
      expect(secondPage.skills[0].ref).toBe("skills-sh/productivity/notion");
      expect(secondPage.nextCursor).toBeNull();
    });

    it("treats an invalid cursor as offset zero and filters ref-less entries", async () => {
      fetchMock.mockResolvedValueOnce(
        mockJsonResponse(
          200,
          buildIndexPayload([{ name: "no-identifier" }, null, ...SKILL_FIXTURES]),
        ),
      );

      const result = await listSkills({ limit: 1, cursor: "not-a-number" });

      expect(result.skills[0].ref).toBe("official/security/1password");
      expect(result.nextCursor).toBe("1");
    });

    it("respects HERMES_SKILLS_REGISTRY_URL and ignores caches for other URLs", async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload()));
      await listSkills({});

      process.env.HERMES_SKILLS_REGISTRY_URL = "https://registry.example.com/index.json";
      fetchMock.mockResolvedValueOnce(
        mockJsonResponse(200, buildIndexPayload([SKILL_FIXTURES[1]])),
      );

      const result = await listSkills({});

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenLastCalledWith(
        "https://registry.example.com/index.json",
        expect.any(Object),
      );
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].ref).toBe("openai/skills/k8s");
    });

    it("refetches once the TTL has expired", async () => {
      process.env.HERMES_SKILLS_INDEX_TTL_MS = "0";
      fetchMock
        .mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload([SKILL_FIXTURES[0]])))
        .mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload([SKILL_FIXTURES[1]])));

      const first = await listSkills({});
      const second = await listSkills({});

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(first.skills[0].ref).toBe("official/security/1password");
      expect(second.skills[0].ref).toBe("openai/skills/k8s");
    });

    it("serves the stale cache with stale: true when a refresh fails", async () => {
      process.env.HERMES_SKILLS_INDEX_TTL_MS = "0";
      fetchMock
        .mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload([SKILL_FIXTURES[0]])))
        .mockRejectedValueOnce(new Error("network down"));

      await listSkills({});
      const stale = await listSkills({});

      expect(stale.stale).toBe(true);
      expect(stale.skills[0].ref).toBe("official/security/1password");
    });

    it("hydrates from the disk cache without fetching", async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload()));
      await listSkills({});
      expect(fs.existsSync(getIndexCachePath())).toBe(true);

      __resetCacheForTests({ keepDisk: true });
      const result = await listSkills({ limit: 1 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.skills[0].ref).toBe("official/security/1password");
      expect(result.stale).toBe(false);
    });

    it("throws hermes_registry_unavailable when no cache exists and fetch fails", async () => {
      fetchMock.mockRejectedValue(new Error("network down"));

      await expect(listSkills({})).rejects.toMatchObject({
        statusCode: 502,
        code: "hermes_registry_unavailable",
      });
    });

    it("throws hermes_registry_unavailable on non-2xx registry responses", async () => {
      fetchMock.mockResolvedValue(mockJsonResponse(500, { error: "boom" }));

      await expect(listSkills({})).rejects.toMatchObject({
        statusCode: 502,
        code: "hermes_registry_unavailable",
      });
    });

    it("throws hermes_registry_unavailable on malformed index JSON", async () => {
      fetchMock.mockResolvedValue(mockTextResponse(200, "<html>not json</html>"));

      await expect(listSkills({})).rejects.toMatchObject({
        statusCode: 502,
        code: "hermes_registry_unavailable",
      });
    });
  });

  describe("searchSkills", () => {
    it("matches case-insensitive substrings across name/description/tags/ref", async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload()));

      const byTag = await searchSkills({ q: "SECURITY" });
      const byRef = await searchSkills({ q: "skills/k8s" });
      const byDescription = await searchSkills({ q: "notion pages" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(byTag.skills.map((skill) => skill.ref)).toEqual(["official/security/1password"]);
      expect(byRef.skills.map((skill) => skill.ref)).toEqual(["openai/skills/k8s"]);
      expect(byDescription.skills.map((skill) => skill.ref)).toEqual([
        "skills-sh/productivity/notion",
      ]);
    });

    it("caps results at the requested limit", async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload()));

      const result = await searchSkills({ q: "s", limit: 2 });

      expect(result.skills).toHaveLength(2);
    });

    it("throws missing_query for an empty query without touching the registry", async () => {
      await expect(searchSkills({ q: "  " })).rejects.toMatchObject({
        statusCode: 400,
        code: "missing_query",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("getSkillDetail", () => {
    it("returns the full index entry for an exact identifier match", async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload()));

      const detail = await getSkillDetail("official/security/1password");

      expect(detail).toEqual({
        ref: "official/security/1password",
        name: "1password",
        description: "Manage 1Password vaults.",
        source: "official",
        trustLevel: "builtin",
        tags: ["security", "passwords"],
        repo: "https://github.com/headmaster/skills",
        path: "security/1password",
        extra: { verified: true },
        stale: false,
      });
    });

    it("throws skill_not_found for unknown refs", async () => {
      fetchMock.mockResolvedValueOnce(mockJsonResponse(200, buildIndexPayload()));

      await expect(getSkillDetail("official/does/not-exist")).rejects.toMatchObject({
        statusCode: 404,
        code: "skill_not_found",
      });
    });

    it("throws skill_not_found for an empty ref without touching the registry", async () => {
      await expect(getSkillDetail("   ")).rejects.toMatchObject({
        statusCode: 404,
        code: "skill_not_found",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
