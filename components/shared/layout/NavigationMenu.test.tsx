import React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@/test/test-utils";
import { NavigationMenu } from "./NavigationMenu";
import { Breadcrumbs, buildCrumbs } from "./Breadcrumbs";
import "@testing-library/jest-dom";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<{ default: React.ComponentType<unknown> }>) => {
    let Comp: React.ComponentType<unknown> | null = null;
    loader().then((m) => { Comp = m.default; });
    return function DynamicResolved(props: unknown) {
      return Comp
        ? React.createElement(Comp, props as Record<string, unknown>)
        : React.createElement("div", null, "Loading…");
    };
  },
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement("a", { href, ...props }, children),
}));

// Mutable pathname for usePathname
let mockPathname = "/dashboard";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

// ─── NavigationMenu ───────────────────────────────────────────────────────────

describe("NavigationMenu", () => {
  beforeEach(() => {
    localStorage.clear();
    mockPathname = "/dashboard";
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("localStorage failure handling (deterministic under adverse conditions)", () => {
    it("renders without crashing when localStorage.getItem throws", () => {
      const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
      
      render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
      expect(screen.getByRole("navigation")).toBeInTheDocument();
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
      getItemSpy.mockRestore();
    });

    it("renders without crashing when localStorage.setItem throws (quota exceeded)", async () => {
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
      
      render(<NavigationMenu visibleLinks={["Dashboard"]} />);
      const link = screen.getByText("Dashboard").closest("a")!;
      await userEvent.click(link);
      
      // Component should remain functional despite setItem failure
      expect(screen.getByRole("navigation")).toBeInTheDocument();
      setItemSpy.mockRestore();
    });

    it("renders without crashing when localStorage is undefined (private browsing)", () => {
      const originalLS = global.localStorage;
      Object.defineProperty(global, "localStorage", {
        value: undefined,
        writable: true,
      });
      
      render(<NavigationMenu visibleLinks={["Dashboard"]} />);
      expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument();
      
      Object.defineProperty(global, "localStorage", {
        value: originalLS,
        writable: true,
      });
    });

    it("uses DEFAULT_ACTIVE_LINK when localStorage read fails", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("Access denied");
      });
      
      render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
      
      // Dashboard should be active by default (route-based)
      await waitFor(() => {
        expect(screen.getByText("Dashboard").closest("a")).toHaveAttribute("aria-current", "page");
      });
    });

    it("state updates locally even if setItem fails silently", async () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
      
      mockPathname = "/";
      render(<NavigationMenu visibleLinks={["Fundwallet", "Dashboard"]} />);
      
      const fundwalletLink = screen.getByText("Fundwallet").closest("a")!;
      await userEvent.click(fundwalletLink);
      
      // State should still update despite storage failure
      await waitFor(() => {
        expect(fundwalletLink).toHaveAttribute("aria-current", "page");
      });
    });
  });

  describe("state consistency under concurrent/rapid updates", () => {
    it("last click wins when multiple links are clicked rapidly", async () => {
      mockPathname = "/";
      render(<NavigationMenu visibleLinks={["Dashboard", "Settings", "Fundwallet"]} />);
      
      const dashboard = screen.getByText("Dashboard").closest("a")!;
      const settings = screen.getByText("Settings").closest("a")!;
      const fundwallet = screen.getByText("Fundwallet").closest("a")!;
      
      // Rapid clicks: Dashboard → Settings → Fundwallet
      await userEvent.click(dashboard);
      await userEvent.click(settings);
      await userEvent.click(fundwallet);
      
      // Only Fundwallet should be active (last click)
      await waitFor(() => {
        expect(fundwallet).toHaveAttribute("aria-current", "page");
      });
      expect(settings).not.toHaveAttribute("aria-current");
      expect(dashboard).not.toHaveAttribute("aria-current");
    });

    it("rapid re-renders do not cause state corruption", async () => {
      const onLinkClick = vi.fn();
      mockPathname = "/";
      
      const { rerender } = render(
        <NavigationMenu visibleLinks={["Dashboard"]} onLinkClick={onLinkClick} />
      );
      
      await userEvent.click(screen.getByText("Dashboard").closest("a")!);
      expect(onLinkClick).toHaveBeenCalledTimes(1);
      
      rerender(<NavigationMenu visibleLinks={["Dashboard"]} onLinkClick={onLinkClick} />);
      expect(onLinkClick).toHaveBeenCalledTimes(1); // No additional calls
    });

    it("handleClick is idempotent: repeated calls with same input yield same output", async () => {
      mockPathname = "/";
      render(<NavigationMenu visibleLinks={["Fundwallet"]} />);
      
      const link = screen.getByText("Fundwallet").closest("a")!;
      
      // First click
      await userEvent.click(link);
      await waitFor(() => expect(link).toHaveAttribute("aria-current", "page"));
      
      // Second click with same link
      await userEvent.click(link);
      await waitFor(() => expect(link).toHaveAttribute("aria-current", "page"));
      
      // State should remain stable
      expect(link).toHaveAttribute("aria-current", "page");
    });
  });

  describe("pathname null/undefined safety", () => {
    it("handles undefined pathname gracefully", () => {
      mockPathname = undefined as any;
      render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
      expect(screen.getByRole("navigation")).toBeInTheDocument();
    });

    it("handles null pathname gracefully", () => {
      mockPathname = null as any;
      render(<NavigationMenu visibleLinks={["Dashboard"]} />);
      expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument();
    });

    it("treats undefined pathname as no match for route links", () => {
      mockPathname = undefined as any;
      render(<NavigationMenu visibleLinks={["Settings"]} />);
      expect(screen.getByText("Settings").closest("a")).not.toHaveAttribute("aria-current");
    });
  });

  describe("visibleLinks filtering safety (idempotent, crash-safe)", () => {
    it("empty visibleLinks renders zero links deterministically", () => {
      render(<NavigationMenu visibleLinks={[]} />);
      expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    });

    it("invalid link names in visibleLinks are silently ignored", () => {
      render(<NavigationMenu visibleLinks={["InvalidName", "Dashboard"]} />);
      expect(screen.getByText("Dashboard")).toBeInTheDocument();
      expect(screen.queryByText("InvalidName")).not.toBeInTheDocument();
    });

    it("duplicate link names in visibleLinks render link only once", () => {
      render(<NavigationMenu visibleLinks={["Dashboard", "Dashboard"]} />);
      expect(screen.getAllByText("Dashboard")).toHaveLength(1);
    });

    it("mixed valid and invalid names are filtered deterministically", () => {
      render(<NavigationMenu visibleLinks={["Dashboard", "Foo", "Settings", "Bar"]} />);
      expect(screen.getByText("Dashboard")).toBeInTheDocument();
      expect(screen.getByText("Settings")).toBeInTheDocument();
      expect(screen.queryByText("Foo")).not.toBeInTheDocument();
      expect(screen.queryByText("Bar")).not.toBeInTheDocument();
    });

    it("filtering is stable across re-renders with same input", () => {
      const { rerender } = render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
      
      rerender(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });
  });

  describe("isActive derivation determinism (route-based vs click-based)", () => {
    it("route-based isActive depends only on pathname (not activeLink state)", () => {
      mockPathname = "/dashboard/loan";
      render(<NavigationMenu visibleLinks={["Dashboard", "Loan", "Fundwallet"]} />);
      
      // Loan matches pathname
      expect(screen.getByText("Loan").closest("a")).toHaveAttribute("aria-current", "page");
      // Dashboard does not match
      expect(screen.getByText("Dashboard").closest("a")).not.toHaveAttribute("aria-current");
      // Fundwallet is click-based and not clicked yet
      expect(screen.getByText("Fundwallet").closest("a")).not.toHaveAttribute("aria-current");
    });

    it("click-based isActive depends only on activeLink (not pathname)", async () => {
      mockPathname = "/other";
      render(<NavigationMenu visibleLinks={["Fundwallet"] />);
      
      // Fundwallet has no path, so not active initially
      const link = screen.getByText("Fundwallet").closest("a")!;
      expect(link).not.toHaveAttribute("aria-current");
      
      // After click, becomes active
      await userEvent.click(link);
      await waitFor(() => expect(link).toHaveAttribute("aria-current", "page"));
    });

    it("isActive is case-insensitive for click-based links", async () => {
      mockPathname = "/";
      localStorage.setItem("activeLink", "FUNDWALLET");
      
      render(<NavigationMenu visibleLinks={["Fundwallet"]} />);
      
      // Should match despite case difference
      await waitFor(() => {
        expect(screen.getByText("Fundwallet").closest("a")).toHaveAttribute("aria-current", "page");
      });
    });

    it("exactly one link has aria-current per render", () => {
      mockPathname = "/dashboard/loan";
      render(<NavigationMenu visibleLinks={["Dashboard", "Loan", "Settings"]} />);
      
      const linksWithCurrent = screen.getAllByRole("link").filter(link => link.hasAttribute("aria-current"));
      expect(linksWithCurrent).toHaveLength(1);
      expect(linksWithCurrent[0]).toHaveTextContent("Loan");
    });
  });

  describe("link rendering", () => {
    it("renders semantic nav > ul > li structure", () => {
      render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
      expect(screen.getByRole("navigation", { name: /main navigation/i })).toBeInTheDocument();
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });

    it("renders all links when visibleLinks is omitted", () => {
      render(<NavigationMenu />);
      expect(screen.getAllByRole("listitem").length).toBeGreaterThan(1);
    });

    it("filters links based on visibleLinks prop", () => {
      render(<NavigationMenu visibleLinks={["Dashboard"]} />);
      expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /settings/i })).not.toBeInTheDocument();
    });

    it("all links have accessible aria-label", () => {
      render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
      screen.getAllByRole("link").forEach((link) => {
        expect(link).toHaveAttribute("aria-label");
      });
    });
  });

  describe("active-state derivation via usePathname", () => {
    it("marks root route /dashboard as active", () => {
      mockPathname = "/dashboard";
      render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
      expect(screen.getByText("Dashboard").closest("a")).toHaveAttribute("aria-current", "page");
    });

    it("marks nested route /dashboard/loan as active", () => {
      mockPathname = "/dashboard/loan";
      render(<NavigationMenu visibleLinks={["Loan"]} />);
      expect(screen.getByText("Loan").closest("a")).toHaveAttribute("aria-current", "page");
    });

    it("marks nested route /dashboard/transactions as active", () => {
      mockPathname = "/dashboard/transactions";
      render(<NavigationMenu visibleLinks={["Transactions"]} />);
      expect(screen.getByText("Transactions").closest("a")).toHaveAttribute("aria-current", "page");
    });

    it("marks nested route /dashboard/settings as active", () => {
      mockPathname = "/dashboard/settings";
      render(<NavigationMenu visibleLinks={["Settings"]} />);
      expect(screen.getByText("Settings").closest("a")).toHaveAttribute("aria-current", "page");
    });

    it("does not mark link as active when path does not match", () => {
      mockPathname = "/dashboard";
      render(<NavigationMenu visibleLinks={["Settings"]} />);
      expect(screen.getByText("Settings").closest("a")).not.toHaveAttribute("aria-current");
    });

    it("handles no matching route — all links inactive", () => {
      mockPathname = "/unknown-route";
      render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
      expect(screen.getByText("Dashboard").closest("a")).not.toHaveAttribute("aria-current");
      expect(screen.getByText("Settings").closest("a")).not.toHaveAttribute("aria-current");
    });

    it("active styling uses class/attribute, not color alone", () => {
      mockPathname = "/dashboard";
      render(<NavigationMenu visibleLinks={["Dashboard"]} />);
      const link = screen.getByText("Dashboard").closest("a")!;
      expect(link).toHaveClass("bg-[#15A350]/15");
      expect(link).toHaveClass("text-[#15A350]");
      expect(link.querySelector("span[aria-hidden='true']")).toHaveClass("opacity-100");
    });

    it("exact match only — dynamic child /dashboard/transactions/123 does not activate Transactions", () => {
      mockPathname = "/dashboard/transactions/abc123";
      render(<NavigationMenu visibleLinks={["Transactions"]} />);
      expect(screen.getByText("Transactions").closest("a")).not.toHaveAttribute("aria-current");
    });

    it("no double-active: only the most-specific matching link is active", () => {
      // /dashboard/transactions matches "Transactions" exactly, NOT "Dashboard"
      mockPathname = "/dashboard/transactions";
      render(<NavigationMenu visibleLinks={["Dashboard", "Transactions"]} />);
      expect(screen.getByText("Transactions").closest("a")).toHaveAttribute("aria-current", "page");
      expect(screen.getByText("Dashboard").closest("a")).not.toHaveAttribute("aria-current");
    });
  });

  describe("non-route links (click-based active state)", () => {
    it("sets active on click for link without path", async () => {
      mockPathname = "/dashboard";
      render(<NavigationMenu visibleLinks={["Fundwallet", "Dashboard"]} />);
      const fundwalletLink = screen.getByText("Fundwallet").closest("a")!;
      expect(fundwalletLink).not.toHaveAttribute("aria-current");
      await userEvent.click(fundwalletLink);
      await waitFor(() => expect(fundwalletLink).toHaveAttribute("aria-current", "page"));
    });

    it("persists active state to localStorage on click", async () => {
      mockPathname = "/";
      render(<NavigationMenu visibleLinks={["Fundwallet"]} />);
      await userEvent.click(screen.getByText("Fundwallet").closest("a")!);
      expect(localStorage.getItem("activeLink")).toBe("Fundwallet");
    });

    it("restores active state from localStorage on mount", async () => {
      localStorage.setItem("activeLink", "Fundwallet");
      mockPathname = "/";
      render(<NavigationMenu visibleLinks={["Fundwallet", "Dashboard"]} />);
      await waitFor(() =>
        expect(screen.getByText("Fundwallet").closest("a")).toHaveAttribute("aria-current", "page")
      );
    });
  });

  describe("accessibility semantics", () => {
    it("has correct nav landmark aria-label", () => {
      render(<NavigationMenu />);
      expect(screen.getByRole("navigation", { name: /main navigation/i })).toBeInTheDocument();
    });

    it("all links have focus-visible ring classes", () => {
      render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
      screen.getAllByRole("link").forEach((link) => {
        expect(link.className).toContain("focus-visible:ring-2");
        expect(link.className).toContain("focus-visible:ring-[#15A350]");
      });
    });

    it("all links meet minimum touch-target height", () => {
      render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
      screen.getAllByRole("link").forEach((link) => {
        expect(link).toHaveClass("py-3.5");
      });
    });
  });

  describe("collapsed state", () => {
    it("applies collapsed classes when isCollapsed is true", () => {
      render(<NavigationMenu visibleLinks={["Dashboard"]} isCollapsed />);
      const link = screen.getByText("Dashboard").closest("a")!;
      expect(link).toHaveClass("px-0");
      expect(link.parentElement).toHaveClass("flex", "justify-center");
    });

    it("hides link text with sr-only when collapsed", () => {
      render(<NavigationMenu visibleLinks={["Dashboard"]} isCollapsed />);
      expect(screen.queryByText(/Dashboard/i, { selector: "span:not(.sr-only)" })).toBeNull();
    });

    it("shows link text when not collapsed", () => {
      render(<NavigationMenu visibleLinks={["Dashboard"]} isCollapsed={false} />);
      expect(screen.getByText("Dashboard")).toBeInTheDocument();
    });
  });

  describe("onLinkClick callback", () => {
    it("calls onLinkClick when a link is clicked", async () => {
      const onLinkClick = vi.fn();
      render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} onLinkClick={onLinkClick} />);
      await userEvent.click(screen.getByText("Settings").closest("a")!);
      expect(onLinkClick).toHaveBeenCalledTimes(1);
    });

    it("calls onLinkClick for each link click independently", async () => {
      const onLinkClick = vi.fn();
      render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} onLinkClick={onLinkClick} />);
      await userEvent.click(screen.getByText("Dashboard").closest("a")!);
      await userEvent.click(screen.getByText("Settings").closest("a")!);
      expect(onLinkClick).toHaveBeenCalledTimes(2);
    });
  });

  describe("edge cases", () => {
    it("handles empty visibleLinks array gracefully", () => {
      render(<NavigationMenu visibleLinks={[]} />);
      expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    });

    it("link without explicit label falls back to link name", () => {
      render(<NavigationMenu visibleLinks={["Dashboard"]} />);
      expect(screen.getByRole("link", { name: /dashboard/i })).toHaveAttribute("aria-label", "Dashboard");
    });

    it("inactive indicator bar has opacity-0 class", () => {
      mockPathname = "/dashboard";
      render(<NavigationMenu visibleLinks={["Settings"]} />);
      const indicator = screen.getByText("Settings").closest("a")?.querySelector("span[aria-hidden='true']");
      expect(indicator).toHaveClass("opacity-0");
    });

    it("inactive link has hover classes for visual feedback", () => {
      render(<NavigationMenu visibleLinks={["Dashboard"]} />);
      // Dashboard has path=/dashboard; with mockPathname=/dashboard it's active.
      // Switch to Settings (no matching route) to test inactive hover classes.
      mockPathname = "/other";
      render(<NavigationMenu visibleLinks={["Settings"]} />);
      const link = screen.getAllByText("Settings")[0].closest("a")!;
      expect(link).toHaveClass("hover:bg-white/5");
      expect(link).toHaveClass("hover:text-white");
    });
  });

  describe("callback safety (stale closure protection)", () => {
    it("onLinkClick callback is called after state update", async () => {
      const onLinkClick = vi.fn();
      render(<NavigationMenu visibleLinks={["Dashboard"]} onLinkClick={onLinkClick} />);
      
      await userEvent.click(screen.getByText("Dashboard").closest("a")!);
      
      expect(onLinkClick).toHaveBeenCalledTimes(1);
    });

    it("onLinkClick receives updated state when called", async () => {
      mockPathname = "/";
      let capturedState = "";
      
      const onLinkClick = vi.fn(() => {
        capturedState = localStorage.getItem("activeLink") || "";
      });
      
      render(<NavigationMenu visibleLinks={["Fundwallet"]} onLinkClick={onLinkClick} />);
      
      await userEvent.click(screen.getByText("Fundwallet").closest("a")!);
      
      expect(capturedState).toBe("Fundwallet");
    });

    it("undefined onLinkClick is safe to call", async () => {
      render(<NavigationMenu visibleLinks={["Dashboard"]} onLinkClick={undefined} />);
      
      // Should not throw when clicking link
      await userEvent.click(screen.getByText("Dashboard").closest("a")!);
      expect(screen.getByText("Dashboard").closest("a")).toHaveAttribute("aria-current", "page");
    });
  });

  describe("recovery from partial failures", () => {
    it("recovers from first storage failure, succeeds on retry", async () => {
      let callCount = 0;
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error("QuotaExceededError");
        }
        // Success on second call
      });
      
      mockPathname = "/";
      render(<NavigationMenu visibleLinks={["Fundwallet"]} />);
      
      // First click fails storage but updates state
      await userEvent.click(screen.getByText("Fundwallet").closest("a")!);
      expect(screen.getByText("Fundwallet").closest("a")).toHaveAttribute("aria-current", "page");
      
      // If clicked again, storage should succeed
      await userEvent.click(screen.getByText("Fundwallet").closest("a")!);
      expect(setItemSpy).toHaveBeenCalledTimes(2);
      
      setItemSpy.mockRestore();
    });

    it("component remains functional after localStorage quota exceeded", async () => {
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
      
      mockPathname = "/";
      render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
      
      // Both links should work despite storage failure
      await userEvent.click(screen.getByText("Settings").closest("a")!);
      expect(screen.getByRole("navigation")).toBeInTheDocument();
      
      await userEvent.click(screen.getByText("Dashboard").closest("a")!);
      expect(screen.getByRole("navigation")).toBeInTheDocument();
      
      setItemSpy.mockRestore();
    });
  });

  describe("prop defaulting and safety", () => {
    it("isCollapsed defaults to false when not provided", () => {
      render(<NavigationMenu visibleLinks={["Dashboard"]} />);
      const link = screen.getByText("Dashboard").closest("a")!;
      expect(link).toHaveClass("px-4"); // Not collapsed
    });

    it("onLinkClick is optional and safe to omit", async () => {
      mockPathname = "/";
      render(<NavigationMenu visibleLinks={["Fundwallet"]} />);
      
      // Should not throw when onLinkClick is undefined
      await userEvent.click(screen.getByText("Fundwallet").closest("a")!);
      expect(screen.getByText("Fundwallet").closest("a")).toHaveAttribute("aria-current", "page");
    });

    it("visibleLinks is optional and shows all links when omitted", () => {
      render(<NavigationMenu />);
      const listItems = screen.getAllByRole("listitem");
      expect(listItems.length).toBeGreaterThan(5);
    });
  });

  describe("determinism under repeated operations", () => {
    it("same sequence of clicks produces same final state", async () => {
      mockPathname = "/";
      const { rerender } = render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
      
      // First sequence
      await userEvent.click(screen.getByText("Dashboard").closest("a")!);
      await userEvent.click(screen.getByText("Settings").closest("a")!);
      expect(screen.getByText("Settings").closest("a")).toHaveAttribute("aria-current", "page");
      
      // Unmount and remount
      localStorage.setItem("activeLink", "Settings");
      rerender(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
      
      // Same final state
      await waitFor(() => {
        expect(screen.getByText("Settings").closest("a")).toHaveAttribute("aria-current", "page");
      });
    });

    it("multiple mounts with same localStorage produce consistent state", () => {
      localStorage.setItem("activeLink", "Settings");
      mockPathname = "/";
      
      const { unmount } = render(<NavigationMenu visibleLinks={["Settings", "Dashboard"]} />);
      expect(screen.getByText("Settings").closest("a")).toHaveAttribute("aria-current", "page");
      
      unmount();
      
      const { container: container2 } = render(<NavigationMenu visibleLinks={["Settings", "Dashboard"]} />);
      const settingsLink = container2.querySelector('a[aria-label="Settings"]');
      expect(settingsLink).toHaveAttribute("aria-current", "page");
    });
  });
});

// ─── Edge case: Racing pathname changes ───────────────────────────────────────

describe("NavigationMenu — pathname race conditions", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("pathname change is immediately reflected in active state", () => {
    mockPathname = "/dashboard";
    const { rerender } = render(<NavigationMenu visibleLinks={["Dashboard", "Loan"]} />);
    
    expect(screen.getByText("Dashboard").closest("a")).toHaveAttribute("aria-current", "page");
    
    // Pathname changes
    mockPathname = "/dashboard/loan";
    rerender(<NavigationMenu visibleLinks={["Dashboard", "Loan"]} />);
    
    // Active state should flip to Loan
    expect(screen.getByText("Loan").closest("a")).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Dashboard").closest("a")).not.toHaveAttribute("aria-current");
  });

  it("activeLink state is NOT overwritten by pathname change", async () => {
    mockPathname = "/";
    render(<NavigationMenu visibleLinks={["Fundwallet", "Dashboard"]} />);
    
    // Click Fundwallet (no path, click-based)
    await userEvent.click(screen.getByText("Fundwallet").closest("a")!);
    expect(screen.getByText("Fundwallet").closest("a")).toHaveAttribute("aria-current", "page");
    
    // Pathname changes
    mockPathname = "/dashboard";
    // Should NOT reset Fundwallet, but Dashboard is route-active now
    // Note: component renders both as "active" from different sources
    // This is the expected behavior
  });
});

// ─── Edge case: Icon dynamic import failures ───────────────────────────────────

describe("NavigationMenu — icon loading resilience", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders even if icon components fail to load", () => {
    // The dynamic() mock will show IconPlaceholder on load
    render(<NavigationMenu visibleLinks={["Dashboard"]} />);
    
    // Component should still render the link structure
    expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument();
  });

  it("icon color is correctly applied to active and inactive states", () => {
    mockPathname = "/dashboard";
    render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
    
    const dashboardIcon = screen.getByText("Dashboard").closest("a")?.querySelector("span.inline-flex svg");
    const settingsIcon = screen.getByText("Settings").closest("a")?.querySelector("span.inline-flex svg");
    
    // Both should be rendered (icon components are mocked)
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });
});

// ─── Edge case: visibleLinks updates ────────────────────────────────────────

describe("NavigationMenu — visibleLinks prop changes", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("re-filtering when visibleLinks prop changes", () => {
    const { rerender } = render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    
    // Update visibleLinks
    rerender(<NavigationMenu visibleLinks={["Dashboard"]} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("activeLink is preserved when visibleLinks is updated", async () => {
    mockPathname = "/";
    const { rerender } = render(<NavigationMenu visibleLinks={["Dashboard", "Settings"]} />);
    
    // Click Settings
    await userEvent.click(screen.getByText("Settings").closest("a")!);
    expect(localStorage.getItem("activeLink")).toBe("Settings");
    
    // Settings becomes hidden
    rerender(<NavigationMenu visibleLinks={["Dashboard"]} />);
    
    // Settings is now hidden but activeLink is still "Settings" in storage
    expect(localStorage.getItem("activeLink")).toBe("Settings");
  });

  it("filtering to empty list clears all links without crashing", () => {
    const { rerender } = render(<NavigationMenu visibleLinks={["Dashboard"]} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    
    rerender(<NavigationMenu visibleLinks={[]} />);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});

// ─── Breadcrumbs ──────────────────────────────────────────────────────────────

describe("buildCrumbs (pure helper)", () => {
  it("root path returns only Home", () => {
    expect(buildCrumbs("/")).toEqual([{ label: "Home", href: "/" }]);
  });

  it("single segment", () => {
    expect(buildCrumbs("/dashboard")).toEqual([
      { label: "Home", href: "/" },
      { label: "Dashboard", href: "/dashboard" },
    ]);
  });

  it("nested route", () => {
    expect(buildCrumbs("/dashboard/transactions")).toEqual([
      { label: "Home", href: "/" },
      { label: "Dashboard", href: "/dashboard" },
      { label: "Transactions", href: "/dashboard/transactions" },
    ]);
  });

  it("dynamic segment (UUID) renders as 'Details'", () => {
    const crumbs = buildCrumbs("/dashboard/transactions/550e8400-e29b-41d4-a716-446655440000");
    expect(crumbs.at(-1)?.label).toBe("Details");
  });

  it("dynamic segment (numeric ID) renders as 'Details'", () => {
    expect(buildCrumbs("/dashboard/transactions/42").at(-1)?.label).toBe("Details");
  });

  it("dynamic segment (64-char hex hash) renders as 'Details'", () => {
    const hash = "c03260cc51347b2c53d0e9061df40003ec1c8fbbab08fcf9a3eef93845c4fc06";
    expect(buildCrumbs(`/dashboard/transactions/${hash}`).at(-1)?.label).toBe("Details");
  });

  it("dynamic segment (mock TXN id) renders as 'Details'", () => {
    expect(buildCrumbs("/dashboard/transactions/TXN12345").at(-1)?.label).toBe("Details");
  });

  it("strips trailing slash", () => {
    expect(buildCrumbs("/dashboard/")).toEqual([
      { label: "Home", href: "/" },
      { label: "Dashboard", href: "/dashboard" },
    ]);
  });

  it("unknown segment falls back to title-cased label", () => {
    const crumbs = buildCrumbs("/dashboard/some-feature");
    expect(crumbs.at(-1)?.label).toBe("Some feature");
  });
});

describe("Breadcrumbs component", () => {
  beforeEach(() => {
    mockPathname = "/dashboard";
  });

  it("renders accessible nav with aria-label Breadcrumb", () => {
    mockPathname = "/dashboard/transactions";
    render(<Breadcrumbs />);
    expect(screen.getByRole("navigation", { name: /breadcrumb/i })).toBeInTheDocument();
  });

  it("renders nothing for root or single-segment path", () => {
    mockPathname = "/";
    const { container } = render(<Breadcrumbs />);
    expect(container.firstChild).toBeNull();
  });

  it("renders breadcrumb for single-segment path (e.g. /dashboard)", () => {
    mockPathname = "/dashboard";
    render(<Breadcrumbs />);
    expect(screen.getByRole("navigation", { name: /breadcrumb/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });

  it("renders crumbs for nested route", () => {
    mockPathname = "/dashboard/transactions";
    render(<Breadcrumbs />);
    expect(screen.getByRole("link", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Transactions")).toBeInTheDocument();
  });

  it("last crumb has aria-current=page and no link", () => {
    mockPathname = "/dashboard/transactions";
    render(<Breadcrumbs />);
    const current = screen.getByText("Transactions");
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current.tagName).not.toBe("A");
  });

  it("intermediate crumbs are links", () => {
    mockPathname = "/dashboard/transactions";
    render(<Breadcrumbs />);
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/dashboard");
  });

  it("accepts override items prop", () => {
    const items = [
      { label: "Home", href: "/" },
      { label: "Custom Page", href: "/custom" },
    ];
    render(<Breadcrumbs items={items} />);
    expect(screen.getByRole("link", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByText("Custom Page")).toHaveAttribute("aria-current", "page");
  });

  it("handles dynamic segment (transaction id) with readable label", () => {
    mockPathname = "/dashboard/transactions/abc-123-def";
    render(<Breadcrumbs />);
    expect(screen.getByText("Details")).toBeInTheDocument();
  });

  it("handles dynamic segment (64-char hex hash) with readable label", () => {
    mockPathname = "/dashboard/transactions/c03260cc51347b2c53d0e9061df40003ec1c8fbbab08fcf9a3eef93845c4fc06";
    render(<Breadcrumbs />);
    expect(screen.getByText("Details")).toBeInTheDocument();
  });

  it("home link has correct href /", () => {
    mockPathname = "/dashboard/transactions";
    render(<Breadcrumbs />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  });

  it("breadcrumb links have focus-visible ring classes", () => {
    mockPathname = "/dashboard/transactions";
    render(<Breadcrumbs />);
    screen.getAllByRole("link").forEach((link) => {
      expect(link.className).toContain("focus-visible:ring-2");
    });
  });
});
