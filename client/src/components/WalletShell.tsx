import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { BarChart3, Compass, Home as HomeIcon, Moon, Sun, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/contexts/ThemeContext";

const tabs = [
  { href: "/", label: "首页", icon: HomeIcon, matchPrefix: ["/"] },
  {
    href: "/market",
    label: "市场",
    icon: BarChart3,
    matchPrefix: ["/market", "/trade", "/quote", "/orders"],
  },
  { href: "/discover", label: "发现", icon: Compass, matchPrefix: ["/discover"] },
  { href: "/me", label: "我的", icon: User, matchPrefix: ["/me", "/admin", "/docs", "/deposit", "/withdraw", "/transfer"] },
];

export function WalletShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { theme, toggleTheme, switchable } = useTheme();
  const pathname = location.split("?")[0];
  const isTrade = pathname.startsWith("/trade/") || pathname.startsWith("/quote/");
  const showDecorativeGlow = pathname === "/";
  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex justify-center overflow-hidden transition-colors duration-200">
      {showDecorativeGlow && (
        <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
          <div className="nexus-glow-tl" />
          <div className="nexus-glow-br" />
        </div>
      )}

      <div className={cn("w-full max-w-[520px] relative min-h-[100dvh] flex flex-col z-10 bg-background", isTrade && "shadow-[0_0_0_1px_var(--border)]")}>
        {switchable && !isTrade && (
          <button
            type="button"
            aria-label="切换深浅色主题"
            className="fixed right-[calc(max((100vw-520px)/2,0px)+16px)] top-[calc(12px+env(safe-area-inset-top))] z-50 w-10 h-10 rounded-full bg-card/90 border border-border backdrop-blur flex items-center justify-center text-muted-foreground hover:text-foreground active:scale-95 transition-all shadow-sm"
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
        )}

        <div
          className="flex-1 overflow-y-auto"
          style={{
            paddingBottom: isTrade ? "0px" : "calc(72px + env(safe-area-inset-bottom))",
          }}
        >
          {children}
        </div>

        {!isTrade && (
          <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[520px] z-40 bg-card/92 backdrop-blur-xl border-t border-border safe-bottom">
            <ul className="grid grid-cols-4">
              {tabs.map((t) => {
                const isActive =
                  t.href === "/"
                    ? location === "/"
                    : t.matchPrefix.some((p) => location.startsWith(p));
                const Icon = t.icon;
                return (
                  <li key={t.href}>
                    <Link href={t.href}>
                      <div
                        className={cn(
                          "min-h-[64px] py-2 flex flex-col items-center justify-center gap-1 text-[11px] active:opacity-60 transition-all duration-150",
                          isActive ? "text-primary" : "text-muted-foreground"
                        )}
                      >
                        <div className="relative">
                          <Icon className={cn("w-5 h-5 transition-transform duration-150", isActive && "scale-110")} />
                          {isActive && (
                            <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary" />
                          )}
                        </div>
                        <span className={cn("font-medium", isActive && "font-semibold")}>{t.label}</span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </div>
    </div>
  );
}
