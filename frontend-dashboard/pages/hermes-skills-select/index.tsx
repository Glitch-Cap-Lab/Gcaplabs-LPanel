import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { BookMarked, Boxes, Plus, RefreshCw, Trash2 } from "lucide-react";
import Layout from "../../components/layout/Layout";
import { useToast } from "../../components/Toast";
import { fetchWithAuth } from "../../lib/api";
import {
  clearDeployDraft,
  DeployDraft,
  DeployHermesSkill,
  loadDeployDraft,
  normalizeDeployDraftResources,
  saveDeployDraft,
} from "../../lib/clawhubDeploy";
import SkillDetailCard from "../../components/agents/hermes/SkillDetailCard";
import SkillGrid from "../../components/agents/openclaw/SkillGrid";
import SkillSearchBar from "../../components/agents/openclaw/SkillSearchBar";
import SkillSelectionTray from "../../components/agents/openclaw/SkillSelectionTray";
import { SkillSummary } from "../../components/agents/openclaw/SkillCard";
import {
  browseSummaryToCardSkill,
  computeLibraryRefs,
  HermesLibraryEntry,
  HermesSkillSummary,
} from "../../lib/hermesSkillsView";

const REGISTRY_UNAVAILABLE_MESSAGE =
  "Could not load skills. The skills index may be unavailable.";

type HermesSkillDetail = HermesSkillSummary & {
  repo?: string;
  path?: string;
};

type SkillListResponse = {
  skills?: HermesSkillSummary[];
  error?: string;
  message?: string;
};

function buildSelectedSkill(detail: HermesSkillDetail): DeployHermesSkill {
  return {
    source: "hermes-hub",
    ref: detail.ref,
    name: detail.name || detail.ref,
    installMode: "cli",
    installedAt: new Date().toISOString(),
    ...(detail.description ? { description: detail.description } : {}),
  };
}

export default function HermesSkillsSelectPage() {
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<DeployDraft | null>(null);
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<HermesSkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<HermesSkillSummary | null>(null);
  const [selectedSkillDetail, setSelectedSkillDetail] = useState<HermesSkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedSkills, setSelectedSkills] = useState<DeployHermesSkill[]>([]);
  const [selectionBusyRef, setSelectionBusyRef] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [library, setLibrary] = useState<HermesLibraryEntry[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryBusyId, setLibraryBusyId] = useState<string | null>(null);
  const [libraryAddBusyRef, setLibraryAddBusyRef] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const detailCacheRef = useRef<Record<string, HermesSkillDetail>>({});

  const showingDefaultBrowseEmptyState = !query.trim() && !loading && !error && skills.length === 0;
  const browseCards = useMemo(() => skills.map(browseSummaryToCardSkill), [skills]);
  // The skill name is the Hermes install identity (dedup key); browse cards
  // are keyed by registry ref, so the grid's selection badges need the refs.
  const selectedSkillNames = useMemo(
    () => new Set(selectedSkills.map((skill) => skill.name)),
    [selectedSkills],
  );
  const selectedSkillRefs = useMemo(
    () => new Set(selectedSkills.map((skill) => skill.ref)),
    [selectedSkills],
  );
  const libraryRefs = useMemo(() => computeLibraryRefs(library), [library]);
  // The shared tray renders ClawHub-shaped rows; map the Hermes entries at
  // this boundary (name doubles as the slug identity, the registry ref shows
  // as the pagePath) so the openclaw component renders them unmodified.
  const traySkills = useMemo(
    () =>
      selectedSkills.map((skill) => ({
        source: "clawhub" as const,
        installSlug: skill.name,
        author: "",
        pagePath: skill.ref,
        installedAt: skill.installedAt,
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
      })),
    [selectedSkills],
  );

  useEffect(() => {
    const nextDraft = loadDeployDraft();
    if (!nextDraft) {
      toast.error("Start from the deploy page before choosing Hermes skills.");
      router.replace("/deploy");
      return;
    }

    const draftRuntimeFamily = String(nextDraft.runtimeFamily || "openclaw")
      .trim()
      .toLowerCase();
    if (draftRuntimeFamily !== "hermes") {
      toast.error("Hermes skills are only available for Hermes agents.");
      router.replace("/deploy");
      return;
    }

    const normalizedDraft = {
      ...nextDraft,
      runtimeFamily: draftRuntimeFamily,
    };

    setDraft(normalizedDraft);
    setSelectedSkills(
      Array.isArray(normalizedDraft.hermesSkills) ? normalizedDraft.hermesSkills : [],
    );
  }, [router, toast]);

  useEffect(() => {
    if (!draft) return;
    saveDeployDraft({
      ...draft,
      hermesSkills: selectedSkills,
    });
  }, [draft, selectedSkills]);

  async function loadBrowseResults() {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const res = await fetchWithAuth("/api/hermes-skills/skills");
      const data: SkillListResponse = await res.json();
      if (requestId !== requestIdRef.current) return;

      if (!res.ok) {
        throw new Error(data.message || data.error || REGISTRY_UNAVAILABLE_MESSAGE);
      }

      setSkills(Array.isArray(data.skills) ? data.skills : []);
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      setSkills([]);
      setError(err?.message || REGISTRY_UNAVAILABLE_MESSAGE);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }

  async function searchSkills() {
    const trimmed = query.trim();
    if (!trimmed) {
      loadBrowseResults();
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const res = await fetchWithAuth(
        `/api/hermes-skills/skills/search?q=${encodeURIComponent(trimmed)}`,
      );
      const data: SkillListResponse = await res.json();
      if (requestId !== requestIdRef.current) return;

      if (!res.ok) {
        throw new Error(data.message || data.error || REGISTRY_UNAVAILABLE_MESSAGE);
      }

      setSkills(Array.isArray(data.skills) ? data.skills : []);
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      setSkills([]);
      setError(err?.message || REGISTRY_UNAVAILABLE_MESSAGE);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }

  async function loadLibrary() {
    setLibraryError(null);
    try {
      const res = await fetchWithAuth("/api/hermes-skills/library");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || "Could not load the skills library.");
      }
      setLibrary(Array.isArray(data.skills) ? data.skills : []);
    } catch (err: any) {
      setLibraryError(err?.message || "Could not load the skills library.");
    }
  }

  async function fetchSkillDetail(ref: string) {
    const cached = detailCacheRef.current[ref];
    if (cached) {
      return cached;
    }

    const res = await fetchWithAuth(
      `/api/hermes-skills/skills/detail?ref=${encodeURIComponent(ref)}`,
    );
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.message || data.error || "Could not load skill details.");
    }

    detailCacheRef.current[ref] = data;
    return data as HermesSkillDetail;
  }

  // The grid hands back card objects keyed by slug; the slug IS the registry
  // ref for Hermes browse cards.
  async function loadSkillDetail(card: SkillSummary) {
    setSelectedSkill({ ref: card.slug, name: card.name, description: card.description });
    setSelectedSkillDetail(detailCacheRef.current[card.slug] || null);
    setDetailError(null);
    setDetailLoading(true);

    try {
      const detail = await fetchSkillDetail(card.slug);
      setSelectedSkill(detail);
      setSelectedSkillDetail(detail);
    } catch (err: any) {
      setDetailError(err?.message || "Could not load skill details.");
    } finally {
      setDetailLoading(false);
    }
  }

  function addSelectedSkill(nextSkill: DeployHermesSkill) {
    setSelectedSkills((current) => {
      if (current.some((entry) => entry.name === nextSkill.name)) {
        return current;
      }
      return [...current, nextSkill];
    });
  }

  function removeSelectedSkillByName(name: string) {
    setSelectedSkills((current) => current.filter((entry) => entry.name !== name));
  }

  function removeSelectedSkillByRef(ref: string) {
    setSelectedSkills((current) => current.filter((entry) => entry.ref !== ref));
  }

  function clearSelectedSkills() {
    setSelectedSkills([]);
  }

  async function toggleSkillSelection(card: SkillSummary) {
    const ref = card.slug;
    if (selectedSkillRefs.has(ref)) {
      removeSelectedSkillByRef(ref);
      return;
    }

    setSelectionBusyRef(ref);
    try {
      const detail = detailCacheRef.current[ref] || (await fetchSkillDetail(ref));
      addSelectedSkill(buildSelectedSkill(detail));
    } catch (err: any) {
      toast.error(err?.message || "Could not select that skill.");
    } finally {
      setSelectionBusyRef(null);
    }
  }

  function handleSelectLibraryEntry(entry: HermesLibraryEntry) {
    addSelectedSkill(
      buildSelectedSkill({
        ref: entry.ref,
        name: entry.name || entry.ref,
        description: entry.description,
      }),
    );
  }

  async function handleAddToLibrary(skill: HermesSkillSummary) {
    if (!skill?.ref || libraryRefs.has(skill.ref)) return;
    setLibraryAddBusyRef(skill.ref);
    try {
      const res = await fetchWithAuth("/api/hermes-skills/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ref: skill.ref,
          name: skill.name || skill.ref,
          description: skill.description || "",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || "Could not add that skill to the library.");
      }
      toast.success(`${data.name || skill.name || skill.ref} added to the library.`);
      await loadLibrary();
    } catch (err: any) {
      toast.error(err?.message || "Could not add that skill to the library.");
    } finally {
      setLibraryAddBusyRef(null);
    }
  }

  async function handleRemoveLibraryEntry(entry: HermesLibraryEntry) {
    setLibraryBusyId(entry.id || null);
    try {
      const res = await fetchWithAuth(
        `/api/hermes-skills/library/${encodeURIComponent(entry.id || "")}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          data.message || data.error || "Could not remove that skill from the library.",
        );
      }
      setLibrary((current) => current.filter((row) => row.id !== entry.id));
    } catch (err: any) {
      toast.error(err?.message || "Could not remove that skill from the library.");
    } finally {
      setLibraryBusyId(null);
    }
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    if (!value.trim()) {
      setSelectedSkill(null);
      setSelectedSkillDetail(null);
      setDetailError(null);
      loadBrowseResults();
    }
  }

  function handleClearSearch() {
    setQuery("");
    setSelectedSkill(null);
    setSelectedSkillDetail(null);
    setDetailError(null);
    loadBrowseResults();
  }

  async function handleDeploy() {
    if (!draft) return;

    const normalizedResources = normalizeDeployDraftResources(draft);

    setDeploying(true);
    try {
      const res = await fetchWithAuth("/api/agents/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          runtime_family: draft.runtimeFamily,
          deploy_target: draft.deployTarget,
          execution_target_id: draft.deployTarget,
          sandbox_profile: draft.sandboxProfile || "standard",
          ...(draft.containerName.trim() ? { container_name: draft.containerName.trim() } : {}),
          ...(draft.model ? { model: draft.model } : {}),
          ...(draft.deploymentMode === "migrate" && draft.migrationDraft?.id
            ? { migration_draft_id: draft.migrationDraft.id }
            : {}),
          ...(draft.vcpu ? { vcpu: normalizedResources.vcpu } : {}),
          ...(draft.ramMb ? { ram_mb: normalizedResources.ramMb } : {}),
          ...(draft.diskGb ? { disk_gb: normalizedResources.diskGb } : {}),
          hermes_skills: selectedSkills.map((skill) => ({
            source: "hermes-hub",
            ref: skill.ref,
            name: skill.name,
            installMode: "cli",
            installedAt: skill.installedAt,
          })),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        clearDeployDraft();
        window.location.href = data?.id ? `/app/agents/${data.id}` : "/app/agents";
        return;
      }

      if (res.status === 402) {
        toast.error("You've reached your plan's agent limit. Please upgrade.");
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Deployment failed. Please try again.");
      }
    } catch (err) {
      console.error(err);
      toast.error("Network error during deployment.");
    } finally {
      setDeploying(false);
    }
  }

  function handleBack() {
    if (!draft) {
      router.push("/deploy");
      return;
    }

    saveDeployDraft({
      ...draft,
      hermesSkills: selectedSkills,
    });
    router.push("/deploy");
  }

  useEffect(() => {
    if (!draft) return;
    loadBrowseResults();
    loadLibrary();
  }, [draft]);

  return (
    <Layout>
      <div className="space-y-6">
        <div className="rounded-[2rem] border border-slate-200 bg-gradient-to-r from-white via-slate-50 to-blue-50 p-6 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white px-3 py-1 text-[11px] font-black uppercase tracking-[0.18em] text-blue-700">
                <Boxes size={12} />
                Hermes Skills Selection
              </div>
              <h1 className="text-3xl font-black text-slate-900">
                Choose skills for this Hermes agent
              </h1>
              <p className="max-w-3xl text-sm leading-6 text-slate-600">
                Pick from your instance&apos;s Skills Library or search the Hermes Skills Hub, then
                attach only the skills you want saved on this Hermes agent at deploy time. LPanel
                installs them once the runtime is ready.
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                loadBrowseResults();
                loadLibrary();
              }}
              disabled={loading}
              className="inline-flex items-center gap-2 self-start rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </div>

        <SkillSelectionTray
          skills={traySkills}
          deploying={deploying}
          emptyMessage="No Hermes skills selected. You can still continue and deploy the agent without any."
          onBack={handleBack}
          onDeploy={handleDeploy}
          onRemoveSkill={(skill) => removeSelectedSkillByName(skill.installSlug)}
          onClearAll={clearSelectedSkills}
        />

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="space-y-3">
            <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">
              Skills Library
            </div>
            <div className="flex items-center gap-2 text-2xl font-black text-slate-900">
              <BookMarked size={20} className="text-blue-500" />
              {library.length} saved
            </div>
            <p className="text-sm text-slate-600">
              Skills curated for this LPanel instance. Add one to this deploy&apos;s selection, or
              remove it from the shared library.
            </p>
            {libraryError ? (
              <p className="text-sm font-medium text-red-600">{libraryError}</p>
            ) : null}
          </div>

          {library.length ? (
            <div className="mt-5 grid grid-cols-1 gap-3 xl:grid-cols-2">
              {library.map((entry) => {
                const selected = selectedSkillNames.has(entry.name || entry.ref);
                return (
                  <div
                    key={entry.id || entry.ref}
                    className="flex h-full flex-col justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-black text-slate-900">{entry.name}</div>
                      <div className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                        {entry.ref}
                      </div>
                      {entry.description ? (
                        <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-600">
                          {entry.description}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleSelectLibraryEntry(entry)}
                        disabled={selected}
                        className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-black text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
                      >
                        <Plus size={12} />
                        {selected ? "Selected" : "Add to selection"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveLibraryEntry(entry)}
                        disabled={libraryBusyId === entry.id}
                        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-600 transition-colors hover:bg-slate-100 hover:text-rose-700 disabled:opacity-60"
                      >
                        <Trash2 size={12} />
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-6 text-center">
              <p className="text-sm font-bold text-slate-700">No skills in the library yet.</p>
              <p className="mt-1 text-xs text-slate-500">
                Open a skill below and choose &quot;Add to library&quot; to pin it for every
                operator on this instance.
              </p>
            </div>
          )}
        </div>

        <SkillSearchBar
          placeholder="Search Hermes skills and press Enter"
          query={query}
          loading={loading}
          onQueryChange={handleQueryChange}
          onSubmit={searchSkills}
          onClear={handleClearSearch}
        />

        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.9fr)]">
          <div className="min-w-0">
            <SkillGrid
              loadingLabel="Loading Hermes skills..."
              skills={browseCards}
              loading={loading}
              error={error}
              query={query}
              selectedSlug={selectedSkill?.ref || null}
              selectedSkillSlugs={selectedSkillRefs}
              selectionBusySlug={selectionBusyRef}
              onSelect={loadSkillDetail}
              onToggleSelection={toggleSkillSelection}
              emptyTitle={
                showingDefaultBrowseEmptyState
                  ? "Search the Hermes Skills Hub to discover skills."
                  : "No skills found."
              }
              emptyMessage={
                showingDefaultBrowseEmptyState
                  ? "The registry returned an empty default browse list. Enter a search and press Enter to find skills."
                  : undefined
              }
            />
          </div>

          <div className="min-w-0">
            <SkillDetailCard
              skill={selectedSkill}
              detail={selectedSkillDetail}
              loading={detailLoading}
              error={detailError}
              inLibrary={selectedSkill ? libraryRefs.has(selectedSkill.ref) : false}
              libraryBusy={selectedSkill ? libraryAddBusyRef === selectedSkill.ref : false}
              onAddToLibrary={handleAddToLibrary}
              onClose={() => {
                setSelectedSkill(null);
                setSelectedSkillDetail(null);
                setDetailError(null);
                setDetailLoading(false);
              }}
            />
          </div>
        </div>
      </div>
    </Layout>
  );
}
