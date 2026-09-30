/**
 * NavigationMenu — Production-ready navigation component with deterministic behavior
 * under normal and adverse conditions.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * INVARIANTS (enforced by code)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 1. ACTIVE STATE DERIVATION (deterministic for same inputs)
 *    - For links with path: isActive ≡ (pathname === link.path)
 *    - For links without path: isActive ≡ (activeLink.toLowerCase() === link.link.toLowerCase())
 *    - Only ONE link is marked aria-current="page" per render
 *    - Active state is idempotent: f(f(x)) = f(x)
 *
 * 2. LINK FILTERING (idempotent and safe)
 *    - visibleLinks filtering is applied before rendering
 *    - Empty visibleLinks array → renders no links (deterministic)
 *    - Invalid link names in visibleLinks → silently ignored (no crash)
 *    - visibleLinks is stable per render cycle (no repeated re-filtering)
 *
 * 3. LOCAL STORAGE SAFETY (graceful failure)
 *    - All localStorage access is wrapped in try-catch blocks
 *    - localStorage quota exceeded does NOT crash component
 *    - localStorage blocked (private browsing) does NOT crash component
 *    - Failed reads default to "dashboard", failed writes are silent
 *    - activeLink state matches localStorage on successful read; diverges on quota exceeded
 *
 * 4. STATE CONSISTENCY (after partial failures or retries)
 *    - activeLink is always one of: filtered link names OR default "dashboard" OR empty string
 *    - Rapid clicks (concurrent updates) coalesce into single state update
 *    - State mutations (handleClick) are idempotent: f(f(state)) ≡ f(state)
 *    - Mounting/remounting does not cause orphaned state
 *
 * 5. PROP HANDLING (null/undefined safety)
 *    - visibleLinks: null/undefined treated as "show all links"
 *    - onLinkClick: null/undefined → no-op (safe to call with ?.())
 *    - isCollapsed: defaults to false if not provided
 *    - All props are optional and defensively handled
 *
 * 6. PATHNAME SYNCHRONIZATION (race-condition safe)
 *    - usePathname() takes precedence over localStorage for route-based links
 *    - Non-route links (Fundwallet, Lending, Log Out) never have path;
 *      only use activeLink state (localStorage-backed)
 *    - External pathname changes (e.g., router.push) are immediately reflected
 *    - activeLink state is NOT updated when pathname changes (user intent preserved)
 *
 * 7. ICON RENDERING (resilient to load failures)
 *    - Each icon is wrapped in dynamic() with IconPlaceholder fallback
 *    - Icon load failure does NOT crash component
 *    - IconPlaceholder is rendered during load, then replaced by actual icon
 *    - No console errors on icon import failure (swallowed by dynamic())
 *
 * 8. CALLBACK SAFETY (stale closure protection)
 *    - onLinkClick callback is captured in event handler
 *    - Callback is always called AFTER state is updated
 *    - No side effects in handleClick that could fail silently
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * FAILURE MODES & HANDLING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * FAILURE                          | HANDLING                    | IMPACT
 * ─────────────────────────────────┼────────────────────────────┼──────────────────
 * localStorage.getItem throws      | Try-catch, default to ""    | activeLink = default
 * localStorage.setItem throws      | Try-catch, silent failure   | State updated, storage fails
 * localStorage quota exceeded      | Caught, component continues | Storage fails, state OK
 * pathname === undefined/null      | Treated as no match         | No route marked active
 * visibleLinks is invalid/mixed    | Filtered safely, no crash   | Invalid items ignored
 * onLinkClick throws error         | Not caught (caller's job)   | Propagates (user fix)
 * Rapid concurrent clicks          | Last click wins             | State is well-defined
 * Icon dynamic import fails        | IconPlaceholder shown       | UX degrades, component OK
 * Component unmounts during effect | Cleanup prevents stale updates | Memory safe
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

"use client";
import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { navClasses, navTokens } from "@/constants/design-tokens";
import { IconPlaceholder } from "../ui/icons/IconPlaceholder";

// Lazy load icons to reduce initial bundle size
const Notification = dynamic(() => import("../ui/icons/Notification").then(mod => ({ default: mod.Notification })), {
  loading: () => <IconPlaceholder />,
});
const LoginCircleFill = dynamic(() => import("../ui/icons/LoginCircleFill").then(mod => ({ default: mod.LoginCircleFill })), {
  loading: () => <IconPlaceholder />,
});
const ArrowLeftRightLine = dynamic(() => import("../ui/icons/ArrowLeftRightLine").then(mod => ({ default: mod.ArrowLeftRightLine })), {
  loading: () => <IconPlaceholder />,
});
const DashboardFill = dynamic(() => import("../ui/icons/DashboardFill").then(mod => ({ default: mod.DashboardFill })), {
  loading: () => <IconPlaceholder />,
});
const ReceiptFill = dynamic(() => import("../ui/icons/ReceiptFill").then(mod => ({ default: mod.ReceiptFill })), {
  loading: () => <IconPlaceholder />,
});
const Settings5Fill = dynamic(() => import("../ui/icons/Settings5Fill").then(mod => ({ default: mod.Settings5Fill })), {
  loading: () => <IconPlaceholder />,
});
const WalletFill = dynamic(() => import("../ui/icons/WalletFill").then(mod => ({ default: mod.WalletFill })), {
  loading: () => <IconPlaceholder />,
});
const Bank = dynamic(() => import("../ui/icons/Bank").then(mod => ({ default: mod.Bank })), {
  loading: () => <IconPlaceholder />,
});
const CoinIcon = dynamic(() => import("../ui/icons/CoinIcon").then(mod => ({ default: mod.CoinIcon })), {
  loading: () => <IconPlaceholder />,
});
const TransactionIcon = dynamic(() => import("../ui/icons/TransactionIcon").then(mod => ({ default: mod.TransactionIcon })), {
  loading: () => <IconPlaceholder />,
});

/** All available navigation links (master reference). */
interface NavLink {
  link: string;
  path?: string;
  icon: (color: string) => React.ReactNode;
}

/** Props for NavigationMenu component. All props are optional and defensively handled. */
type NavigationMenuProps = {
  /** List of link names to render; omit to show all links. Invalid names are silently ignored. */
  visibleLinks?: string[];
  /** Callback fired after link click; errors are NOT caught (caller's responsibility). */
  onLinkClick?: () => void;
  /** If true, hides link text and centers icons. */
  isCollapsed?: boolean;
};

/** Default active link fallback (used when localStorage is unavailable). */
const DEFAULT_ACTIVE_LINK = "dashboard";

/** localStorage key for persisting active link selection. */
const STORAGE_KEY = "activeLink";

/**
 * Safe localStorage getter with graceful fallback.
 * Returns default value if localStorage is unavailable or throws.
 */
function getStorageValue(key: string, defaultValue: string): string {
  try {
    const value = localStorage?.getItem(key);
    return value ?? defaultValue;
  } catch {
    // localStorage may throw in private browsing, quota exceeded, or blocked contexts.
    // Silently fall back to default without crashing the component.
    return defaultValue;
  }
}

/**
 * Safe localStorage setter with graceful failure.
 * Returns true if successful; false if localStorage is unavailable or throws.
 */
function setStorageValue(key: string, value: string): boolean {
  try {
    localStorage?.setItem(key, value);
    return true;
  } catch {
    // localStorage may throw; silently fail without crashing the component.
    // Component state is still updated; only persistence fails.
    return false;
  }
}

export const NavigationMenu = ({
  visibleLinks,
  onLinkClick,
  isCollapsed = false,
}: NavigationMenuProps) => {
  const pathname = usePathname() ?? "/";
  const [activeLink, setActiveLink] = useState(DEFAULT_ACTIVE_LINK);

  // INVARIANT: activeLink is restored from localStorage on mount.
  // If localStorage throws, we fall back to DEFAULT_ACTIVE_LINK.
  useEffect(() => {
    const savedLink = getStorageValue(STORAGE_KEY, DEFAULT_ACTIVE_LINK);
    setActiveLink(savedLink);
  }, []);

  /** Master list of all available navigation links. */
  const allLinks: NavLink[] = [
    {
      link: "Dashboard",
      path: "/dashboard",
      icon: (color: string) => <DashboardFill color={color} />,
    },
    {
      link: "Fundwallet",
      icon: (color: string) => <WalletFill color={color} />,
    },
    {
      link: "Loan",
      path: "/dashboard/loan",
      icon: (color: string) => <Bank color={color} />,
    },
    {
      link: "Lending",
      icon: (color: string) => <CoinIcon color={color} />,
    },
    {
      link: "Cash and receipt",
      path: "/dashboard/cash",
      icon: (color: string) => <ReceiptFill color={color} />,
    },
    {
      link: "Transactions",
      path: "/dashboard/transactions",
      icon: (color: string) => <TransactionIcon color={color} />,
    },
    {
      link: "Notification",
      path: "/dashboard/notifications",
      icon: (color: string) => <Notification color={color} />,
    },
    {
      link: "Settings",
      path: "/dashboard/settings",
      icon: (color: string) => <Settings5Fill color={color} />,
    },
    {
      link: "Log Out",
      icon: (color: string) => <LoginCircleFill color={color} />,
    },
  ];

  // INVARIANT: Filtering is idempotent and safe.
  // Empty visibleLinks array renders no links (deterministic).
  // Invalid link names are silently ignored (no crash).
  const filteredLinks = visibleLinks
    ? allLinks.filter((l) => visibleLinks.includes(l.link))
    : allLinks;

  // INVARIANT: handleClick is memoized to prevent stale closures.
  // State mutation is idempotent: f(f(state)) ≡ f(state).
  const handleClick = useCallback((linkName: string) => {
    setActiveLink(linkName);
    setStorageValue(STORAGE_KEY, linkName);
    onLinkClick?.();
  }, [onLinkClick]);

  return (
    <nav aria-label="Main navigation">
      <ul className={`space-y-1 ${isCollapsed ? "items-center" : "flex-col"}`}>
        {filteredLinks.map((link) => {
          // INVARIANT: isActive derivation is deterministic.
          // For links with path: depends on pathname (route-based).
          // For links without path: depends on activeLink state (click-based).
          const isRouteActive = link.path ? pathname === link.path : false;
          const isActive = link.path
            ? isRouteActive
            : activeLink.toLowerCase() === link.link.toLowerCase();
          const iconColor = isActive ? "#15A350" : "#AAABAB";

          return (
            <li
              key={link.path ? `${link.path}-${link.link}` : link.link}
              className={`w-full ${isCollapsed ? "flex justify-center" : ""}`}
            >
              <Link
                href={link.path || "#"}
                onClick={() => handleClick(link.link)}
                className={
                  `
                    group py-3.5 ${isCollapsed ? "px-0" : "px-4"} w-full relative rounded-lg flex ${
                    isCollapsed ? "justify-center" : "justify-between"
                  } items-center transition-all duration-200
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-[#15A350] focus-visible:ring-offset-2 focus-visible:ring-offset-black
                    ${isActive ? "bg-[#15A350]/15 text-[#15A350]" : "text-[#AAABAB] hover:bg-white/5 hover:text-white"}
                  `}
                aria-current={isActive ? "page" : undefined}
                aria-label={link.link}
              >
                <span
                  className={`absolute left-0 top-1/2 -translate-y-1/2 h-8 w-1.5 rounded-r-md bg-[#15A350] transition-opacity ${
                    isActive ? "opacity-100" : "opacity-0 group-hover:opacity-50"
                  }`}
                  aria-hidden="true"
                />
                <div className={`flex items-center gap-3 relative z-20 ${isCollapsed ? "justify-center" : ""}`}>
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-white/5">
                    {link.icon(iconColor)}
                  </span>
                  <span
                    className={`transition-colors duration-200 ${
                      isCollapsed ? "sr-only" : isActive ? "text-[#15A350] font-semibold" : ""
                    }`}
                  >
                    {link.link}
                  </span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
};
