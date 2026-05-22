/**
 * NotificationBell — polls for unread count every 10s, shows badge,
 * opens a dropdown with recent notifications, and fires a toast
 * when a new notification arrives.
 */
import { useEffect, useRef, useState } from "react";
import { Bell, BellDot, CheckCheck, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";

function formatRelTime(date: Date | string | null | undefined) {
  if (!date) return "";
  const d = new Date(date as string);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

export function NotificationBell() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const countQ = trpc.exchange.unreadNotificationCount.useQuery(undefined, {
    enabled: !!user,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });

  const notifsQ = trpc.exchange.getNotifications.useQuery(
    { limit: 30 },
    { enabled: !!user && open }
  );

  const markRead = trpc.exchange.markNotificationsRead.useMutation({
    onSuccess: () => {
      countQ.refetch();
      notifsQ.refetch();
    },
  });

  const unread = countQ.data ?? 0;

  // Fetch latest notifications to show in toast when count increases
  const latestNotifsQ = trpc.exchange.getNotifications.useQuery(
    { limit: 5 },
    { enabled: !!user, refetchInterval: 10_000, refetchIntervalInBackground: false }
  );
  const prevLatestIdRef = useRef<number | null>(null);

  // Toast when new notifications arrive — show actual notification content
  useEffect(() => {
    const notifs = latestNotifsQ.data;
    if (!notifs || notifs.length === 0) return;
    const latestId = notifs[0].id;
    if (prevLatestIdRef.current === null) {
      prevLatestIdRef.current = latestId;
      return;
    }
    if (latestId !== prevLatestIdRef.current) {
      // Find all new notifications since last seen
      const newNotifs = notifs.filter((n) => n.id > prevLatestIdRef.current!);
      for (const n of newNotifs.slice(0, 3)) {
        toast.success(n.title, {
          description: n.body,
          duration: 6000,
        });
      }
      prevLatestIdRef.current = latestId;
      countQ.refetch();
    }
  }, [latestNotifsQ.data]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!user) return null;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/70 transition-colors"
        aria-label="通知"
      >
        {unread > 0 ? (
          <BellDot size={20} className="text-yellow-500 dark:text-yellow-400" />
        ) : (
          <Bell size={20} className="text-current" />
        )}
        {unread > 0 && (
          <span
            className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold text-white flex items-center justify-center"
            style={{ background: "#ef4444", lineHeight: 1 }}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-80 rounded-2xl bg-popover/95 border border-border text-popover-foreground shadow-2xl z-50 overflow-hidden backdrop-blur-2xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="text-sm font-semibold text-popover-foreground">通知</span>
            <div className="flex items-center gap-2">
              {unread > 0 && (
                <button
                  onClick={() => markRead.mutate({})}
                  className="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity"
                >
                  <CheckCheck size={13} />
                  全部已读
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/70 transition-colors"
              >
                <X size={14} className="text-current" />
              </button>
            </div>
          </div>

          {/* List */}
          <div className="max-h-80 overflow-y-auto">
            {notifsQ.isLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              </div>
            ) : !notifsQ.data || notifsQ.data.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2">
                <Bell size={28} className="text-muted-foreground/40" />
                <p className="text-muted-foreground text-xs">暂无通知</p>
              </div>
            ) : (
              notifsQ.data.map((n) => (
                <div
                  key={n.id}
                  className="px-4 py-3 border-b border-border last:border-0 flex gap-3 items-start cursor-pointer hover:bg-accent/55 transition-colors"
                  onClick={() => {
                    if (!n.isRead) {
                      markRead.mutate({ ids: [n.id] });
                    }
                  }}
                >
                  {/* Unread dot */}
                  <div className="mt-1.5 shrink-0">
                    {!n.isRead ? (
                      <span className="w-2 h-2 rounded-full bg-primary block" />
                    ) : (
                      <span className="w-2 h-2 rounded-full bg-muted block" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <span
                        className={n.isRead ? "text-xs font-semibold truncate text-muted-foreground" : "text-xs font-semibold truncate text-popover-foreground"}
                      >
                        {n.title}
                      </span>
                      <span className="text-[10px] text-muted-foreground shrink-0">{formatRelTime(n.createdAt)}</span>
                    </div>
                    <p
                      className={n.isRead ? "text-[11px] leading-relaxed text-muted-foreground/70" : "text-[11px] leading-relaxed text-muted-foreground"}
                    >
                      {n.body}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
