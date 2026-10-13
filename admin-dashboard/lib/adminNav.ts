// Admin nav entries that belong to an optional deploy target. They are shown
// only when /api/config/platform reports that target enabled; the backend does
// not mount their routes otherwise.
export type PlatformBackends = {
  enabledBackends?: string[] | null;
  remoteHostsEnabled?: boolean | null;
} | null;

const GATED_HREFS: Record<string, (platform: NonNullable<PlatformBackends>) => boolean> = {
  "/kubernetes": (platform) => (platform.enabledBackends || []).includes("k8s"),
  "/remote-hosts": (platform) => platform.remoteHostsEnabled === true,
};

export function isNavItemVisible(href: string, platform: PlatformBackends): boolean {
  const gate = GATED_HREFS[href];
  if (!gate) return true;
  // Until the platform config loads (or if it fails), hide gated surfaces.
  if (!platform) return false;
  return gate(platform);
}
