// Admin nav entries that belong to an optional deploy target or an optional
// admin surface. They are shown only when /api/config/platform reports them
// enabled; the backend does not mount their routes otherwise (Backups keeps
// its routes for recovery and only hides the nav entry).
export type PlatformBackends = {
  enabledBackends?: string[] | null;
  remoteHostsEnabled?: boolean | null;
  adminSurfaces?: string[] | null;
} | null;

const surface = (id: string) => (platform: NonNullable<PlatformBackends>) =>
  (platform.adminSurfaces || []).includes(id);

const GATED_HREFS: Record<string, (platform: NonNullable<PlatformBackends>) => boolean> = {
  "/kubernetes": (platform) => (platform.enabledBackends || []).includes("k8s"),
  "/remote-hosts": (platform) => platform.remoteHostsEnabled === true,
  "/agent-hub": surface("agent-hub"),
  "/user-groups": surface("user-groups"),
  "/members": surface("members"),
  "/queue": surface("queue"),
  "/backups": surface("backups"),
};

export function isNavItemVisible(href: string, platform: PlatformBackends): boolean {
  const gate = GATED_HREFS[href];
  if (!gate) return true;
  // Until the platform config loads (or if it fails), hide gated surfaces.
  if (!platform) return false;
  return gate(platform);
}
