import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import {
  LayoutDashboard,
  ShieldCheck,
  Bot,
  Rocket,
  BarChart3,
  FolderOpen,
  Settings,
  ScrollText,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import { useI18n } from "../../lib/i18n";

type SidebarProps = {
  collapsed?: boolean;
  onToggleCollapse?: (() => void) | null;
  onClose?: (() => void) | null;
  platformMode?: string | null;
};
type NavItem = {
  name: string;
  icon: typeof LayoutDashboard;
  href: string;
  selfHostedOnly?: boolean;
  /** Shown only to platform administrators; navigates within the same origin. */
  adminOnly?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { name: "Dashboard", icon: LayoutDashboard, href: "/app/dashboard" },
  { name: "Agents", icon: Bot, href: "/app/agents" },
  { name: "Deploy", icon: Rocket, href: "/app/deploy" },
  { name: "Workspaces", icon: FolderOpen, href: "/app/workspaces" },
  { name: "Monitoring", icon: BarChart3, href: "/app/monitoring" },
  { name: "Logs", icon: ScrollText, href: "/app/logs" },
  { name: "Platform administration", icon: ShieldCheck, href: "/admin/", adminOnly: true },
];

export default function Sidebar({
  collapsed = false,
  onToggleCollapse,
  onClose,
  platformMode = null,
}: SidebarProps) {
  const router = useRouter();
  const { localizePath, t } = useI18n();
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((user) => {
        if (active && user?.role === "admin") setIsPlatformAdmin(true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const navItems = NAV_ITEMS.filter(
    (item) =>
      (!item.selfHostedOnly || platformMode === "selfhosted") &&
      (!item.adminOnly || isPlatformAdmin),
  );

  const isActive = (path) => {
    const normalized = path.replace(/^\/app/, "") || "/";
    return router.pathname === normalized;
  };

  return (
    <aside
      aria-label={t("Primary navigation")}
      className={clsx(
        "bg-white text-brand-ink hm-admin-sidebar flex flex-col border-r border-brand-cyan/10 z-50 overflow-y-auto transition-all duration-300",
        collapsed ? "w-[68px]" : "w-64",
      )}
    >
      {/* Header */}
      <div
        className={clsx(
          "flex items-center gap-3 shrink-0",
          collapsed ? "p-4 justify-center" : "p-6 pb-8",
        )}
      >
        <span aria-hidden="true" className="hm-brand-mark">
          h
        </span>
        {!collapsed && (
          <div className="hm-brand flex flex-col min-w-0">
            <span className="hm-brand-name">headmaster</span>
            <span className="hm-brand-caption">{t("Control plane")}</span>
          </div>
        )}
        {/* Mobile close button */}
        {onClose && !collapsed && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close navigation menu")}
            className="ml-auto rounded-lg p-1.5 text-brand-ink/55 transition-colors hover:bg-black/5 hover:text-brand-ink lg:hidden"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Nav Items */}
      <nav className={clsx("flex-1 space-y-1", collapsed ? "px-2" : "px-4")}>
        {!collapsed && (
          <div className="mb-4 flex items-center gap-2 px-4 text-[10px] font-bold uppercase tracking-[0.2em] text-brand-cyan/55">
            {t("Main Operations")}
            <div className="ml-2 h-[1px] flex-1 bg-brand-cyan/10"></div>
          </div>
        )}

        {navItems.map((item) => (
          <a
            key={item.name}
            href={localizePath(item.href)}
            className="block"
            title={collapsed ? t(item.name) : undefined}
            aria-label={collapsed ? t(item.name) : undefined}
            aria-current={isActive(item.href) ? "page" : undefined}
          >
            <div
              className={clsx(
                "flex items-center gap-3 rounded-xl text-sm font-medium transition-all group relative",
                collapsed ? "justify-center px-2 py-3" : "px-4 py-3",
                isActive(item.href)
                  ? "bg-brand-ink text-brand-foreground"
                  : "text-brand-ink/62 hover:bg-black/5 hover:text-brand-ink",
              )}
            >
              <item.icon
                size={18}
                className={clsx(
                  "transition-transform group-hover:scale-110 shrink-0",
                  isActive(item.href)
                    ? "text-brand-foreground"
                    : "text-brand-ink/55 group-hover:text-brand-cyan",
                )}
              />
              {!collapsed && t(item.name)}

              {isActive(item.href) && (
                <div
                  aria-hidden="true"
                  className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-brand-cyan"
                ></div>
              )}
            </div>
          </a>
        ))}
      </nav>

      {/* Footer */}
      <div
        className={clsx(
          "mt-auto space-y-1 border-t border-brand-cyan/10",
          collapsed ? "p-2" : "p-4",
        )}
      >
        <a
          href={localizePath("/app/settings")}
          className="block"
          title={collapsed ? t("Settings") : undefined}
          aria-label={collapsed ? t("Settings") : undefined}
          aria-current={isActive("/app/settings") ? "page" : undefined}
        >
          <div
            className={clsx(
              "flex items-center gap-3 rounded-xl text-sm font-medium transition-all group",
              collapsed ? "justify-center px-2 py-3" : "px-4 py-3",
              isActive("/app/settings")
                ? "bg-brand-cyan/16 text-brand-ink"
                : "text-brand-ink/55 hover:bg-black/5 hover:text-brand-ink",
            )}
          >
            <Settings size={18} className="shrink-0" />
            {!collapsed && t("Settings")}
          </div>
        </a>

        {/* Collapse toggle — desktop only */}
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("Expand sidebar") : t("Collapse sidebar")}
            className={clsx(
              "flex items-center gap-3 rounded-xl text-sm font-medium transition-all w-full text-brand-ink/55 hover:bg-black/5 hover:text-brand-ink",
              collapsed ? "justify-center px-2 py-3" : "px-4 py-3",
            )}
            title={collapsed ? t("Expand sidebar") : t("Collapse sidebar")}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            {!collapsed && t("Collapse")}
          </button>
        )}
      </div>
    </aside>
  );
}
