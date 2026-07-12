import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast, Toaster } from "sonner";
import {
  Rss,
  Wand2,
  Sparkles,
  Loader2,
  RefreshCw,
  Plus,
  Trash2,
  CheckCheck,
  ExternalLink,
  LogOut,
  Inbox,
  Circle,
  CircleCheck,
  Menu,
  MoreVertical,
  ArrowUpToLine,
  ArrowDownToLine,
  ChevronLeft,
  Search,
  ListPlus,
  X,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  addFeed,
  bulkAddFeeds,
  deleteFeed,
  deleteItems,
  deleteReadItems,
  listFeeds,
  listItems,
  markAllRead,
  markItemsRead,
  previewFeedSetup,
  refreshAllFeeds,
  refreshFeed,
} from "@/lib/reader.functions";
import type { ExtractedFeed } from "@/lib/feed-extractor";

export const Route = createFileRoute("/_authenticated/reader")({
  head: () => ({
    meta: [
      { title: "Reader — Fae Feeds" },
      { name: "description", content: "Your personal RSS reader." },
    ],
  }),
  component: Reader,
});

type SelKey = string | "__all__";
type FeedRow = {
  id: string;
  url: string;
  title: string | null;
  unread_count?: number;
  last_refreshed_at?: string | null;
  last_error?: string | null;
};

const UNREAD_ONLY_KEY = "faefeeds.unreadOnly.v1";

function Reader() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<SelKey>("__all__");
  // Persisted so the "Unread only" filter stays checked across reloads
  // until the person explicitly unchecks it.
  const [unreadOnly, setUnreadOnly] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(UNREAD_ONLY_KEY) === "1";
  });
  const [addOpen, setAddOpen] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // "Add feed" setup flow: for a genuine RSS/Atom URL we add it right away;
  // for a scraped HTML page we show a checklist so the person can confirm
  // which links are actually articles first.
  const [setupFeed, setSetupFeed] = useState<ExtractedFeed | null>(null);
  const [setupSelected, setSetupSelected] = useState<Record<string, boolean>>({});

  // Bulk-add: paste many URLs at once instead of curating one at a time.
  const [addMode, setAddMode] = useState<"single" | "bulk">("single");
  const [bulkText, setBulkText] = useState("");
  const [bulkResults, setBulkResults] = useState<
    { url: string; ok: boolean; title?: string; itemCount?: number; error?: string }[] | null
  >(null);

  // Filter the feed list in the sidebar by title/url.
  const [feedFilter, setFeedFilter] = useState("");

  // Search articles by title/description. Debounced so we're not firing a
  // query on every keystroke.
  const [itemSearchInput, setItemSearchInput] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setItemSearch(itemSearchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [itemSearchInput]);

  function setUnreadOnlyPersisted(v: boolean) {
    setUnreadOnly(v);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(UNREAD_ONLY_KEY, v ? "1" : "0");
    }
  }

  const feedsFn = useServerFn(listFeeds);
  const itemsFn = useServerFn(listItems);
  const addFn = useServerFn(addFeed);
  const bulkAddFn = useServerFn(bulkAddFeeds);
  const previewSetupFn = useServerFn(previewFeedSetup);
  const delFn = useServerFn(deleteFeed);
  const delItemsFn = useServerFn(deleteItems);
  const delReadFn = useServerFn(deleteReadItems);
  const refreshFn = useServerFn(refreshFeed);
  const refreshAllFn = useServerFn(refreshAllFeeds);
  const markFn = useServerFn(markItemsRead);
  const markAllFn = useServerFn(markAllRead);

  const feedsQuery = useQuery({
    queryKey: ["feeds"],
    queryFn: () => feedsFn(),
    refetchInterval: 60_000,
  });

  const itemsQuery = useQuery({
    queryKey: ["items", selected, unreadOnly, itemSearch],
    queryFn: () =>
      itemsFn({
        data: {
          feedId: selected === "__all__" ? null : selected,
          unreadOnly,
          search: itemSearch || undefined,
        },
      }),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    setChecked({});
  }, [selected, unreadOnly, itemSearch]);

  // Close the mobile sidebar drawer whenever a feed is picked
  useEffect(() => {
    setSidebarOpen(false);
  }, [selected]);

  // Auto-refresh all feeds every 5 minutes on the client too
  useEffect(() => {
    const id = window.setInterval(
      () => {
        refreshAllFn({}).then(() => {
          qc.invalidateQueries({ queryKey: ["feeds"] });
          qc.invalidateQueries({ queryKey: ["items"] });
        }).catch(() => {});
      },
      5 * 60 * 1000,
    );
    return () => window.clearInterval(id);
  }, [refreshAllFn, qc]);

  // Step 1: fetch + inspect the URL. Real RSS/Atom feeds go straight to
  // addMut; scraped HTML pages populate setupFeed so the person can pick
  // which links are real articles.
  const previewMut = useMutation({
    mutationFn: (url: string) => previewSetupFn({ data: { url } }),
    onSuccess: (extracted, url) => {
      if (extracted.isRealFeed) {
        addMut.mutate({ url });
        return;
      }
      setSetupFeed(extracted);
      const initial: Record<string, boolean> = {};
      for (const it of extracted.items) initial[it.link] = true;
      setSetupSelected(initial);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addMut = useMutation({
    mutationFn: (v: { url: string; selectedLinks?: string[] }) => addFn({ data: v }),
    onSuccess: () => {
      toast.success("Feed added");
      setNewUrl("");
      setAddOpen(false);
      setSetupFeed(null);
      setSetupSelected({});
      qc.invalidateQueries({ queryKey: ["feeds"] });
      qc.invalidateQueries({ queryKey: ["items"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const bulkAddMut = useMutation({
    mutationFn: (urls: string[]) => bulkAddFn({ data: { urls } }),
    onSuccess: (res) => {
      setBulkResults(res.results);
      const okCount = res.results.filter((r) => r.ok).length;
      const failCount = res.results.length - okCount;
      if (okCount > 0) {
        toast.success(
          `Added ${okCount} feed${okCount === 1 ? "" : "s"}` +
            (failCount > 0 ? ` (${failCount} failed)` : ""),
        );
      } else {
        toast.error("Couldn't add any of those feeds");
      }
      qc.invalidateQueries({ queryKey: ["feeds"] });
      qc.invalidateQueries({ queryKey: ["items"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const delItemsMut = useMutation({
    mutationFn: (ids: string[]) => delItemsFn({ data: { ids } }),
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["feeds"] });
      qc.invalidateQueries({ queryKey: ["items"] });
      setChecked({});
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const delReadMut = useMutation({
    mutationFn: (feedId: string | null) => delReadFn({ data: { feedId } }),
    onSuccess: (res) => {
      toast.success(
        res.deleted > 0 ? `Deleted ${res.deleted} read item(s)` : "Nothing to delete",
      );
      qc.invalidateQueries({ queryKey: ["feeds"] });
      qc.invalidateQueries({ queryKey: ["items"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const refreshMut = useMutation({
    mutationFn: async (id?: string) => {
      if (id) await refreshFn({ data: { id } });
      else await refreshAllFn({});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["feeds"] });
      qc.invalidateQueries({ queryKey: ["items"] });
    },
  });

  const delMut = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => {
      setSelected("__all__");
      qc.invalidateQueries({ queryKey: ["feeds"] });
      qc.invalidateQueries({ queryKey: ["items"] });
    },
  });

  const markMut = useMutation({
    mutationFn: (v: { ids: string[]; read: boolean }) => markFn({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["feeds"] });
      qc.invalidateQueries({ queryKey: ["items"] });
      setChecked({});
    },
  });

  const markAllMut = useMutation({
    mutationFn: (feedId: string | null) => markAllFn({ data: { feedId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["feeds"] });
      qc.invalidateQueries({ queryKey: ["items"] });
    },
  });

  const items = itemsQuery.data ?? [];
  const feeds: FeedRow[] = feedsQuery.data ?? [];
  const totalUnread = useMemo(
    () => feeds.reduce((s, f) => s + (f.unread_count ?? 0), 0),
    [feeds],
  );

  const selectedFeed =
    selected === "__all__" ? null : feeds.find((f) => f.id === selected);

  const filteredFeeds = useMemo(() => {
    const q = feedFilter.trim().toLowerCase();
    if (!q) return feeds;
    return feeds.filter((f) => (f.title || f.url).toLowerCase().includes(q));
  }, [feeds, feedFilter]);

  const checkedIds = Object.keys(checked).filter((k) => checked[k]);
  const allChecked = items.length > 0 && checkedIds.length === items.length;

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth" });
  }

  function toggleRow(id: string, next?: boolean) {
    setChecked((prev) => ({ ...prev, [id]: next ?? !prev[id] }));
  }

  // "Mark above as read" / "Mark below as read": relative to the item's
  // position in the currently displayed (already sorted) list.
  function markRelative(index: number, direction: "above" | "below") {
    const ids =
      direction === "above"
        ? items.slice(0, index).map((it: any) => it.id)
        : items.slice(index + 1).map((it: any) => it.id);
    const unreadIds = ids.filter(
      (id: string) => !items.find((it: any) => it.id === id)?.is_read,
    );
    if (unreadIds.length === 0) {
      toast.info(
        direction === "above" ? "Nothing above to mark" : "Nothing below to mark",
      );
      return;
    }
    markMut.mutate({ ids: unreadIds, read: true });
  }

  const sidebarContent = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between p-4">
        <Link to="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-primary-foreground">
            <Wand2 className="h-4 w-4" />
          </div>
          <span className="font-display text-lg">Fae Feeds</span>
        </Link>
        <Button size="icon" variant="ghost" onClick={signOut} aria-label="Sign out">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>

      <div className="px-3">
        <Dialog
          open={addOpen}
          onOpenChange={(open) => {
            setAddOpen(open);
            if (!open) {
              setSetupFeed(null);
              setSetupSelected({});
              setNewUrl("");
              setAddMode("single");
              setBulkText("");
              setBulkResults(null);
            }
          }}
        >
          <DialogTrigger asChild>
            <Button className="w-full" size="sm">
              <Plus className="mr-2 h-4 w-4" />
              Add feed
            </Button>
          </DialogTrigger>
          <DialogContent className={setupFeed || addMode === "bulk" ? "sm:max-w-lg" : undefined}>
            {!setupFeed ? (
              <>
                <DialogHeader>
                  <DialogTitle className="font-display text-2xl">
                    Enchant a new URL
                  </DialogTitle>
                </DialogHeader>
                <Tabs
                  value={addMode}
                  onValueChange={(v) => {
                    setAddMode(v as "single" | "bulk");
                    setBulkResults(null);
                  }}
                >
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="single">Single URL</TabsTrigger>
                    <TabsTrigger value="bulk">Bulk import</TabsTrigger>
                  </TabsList>
                </Tabs>
                {addMode === "single" ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      try {
                        new URL(newUrl);
                      } catch {
                        toast.error("Add https:// to the beginning");
                        return;
                      }
                      previewMut.mutate(newUrl);
                    }}
                    className="space-y-3"
                  >
                    <Input
                      value={newUrl}
                      onChange={(e) => setNewUrl(e.target.value)}
                      placeholder="https://a-lovely-blog.example"
                      autoFocus
                    />
                    <p className="text-xs text-muted-foreground">
                      If this isn't a real RSS/Atom feed, we'll scan the page and let
                      you confirm which links are actual articles.
                    </p>
                    <DialogFooter>
                      <Button
                        type="submit"
                        disabled={previewMut.isPending || addMut.isPending || !newUrl}
                      >
                        {previewMut.isPending || addMut.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Sparkles className="mr-2 h-4 w-4" />
                        )}
                        Cast feed
                      </Button>
                    </DialogFooter>
                  </form>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const urls = [
                        ...new Set(
                          bulkText
                            .split(/[\n,]+/)
                            .map((s) => s.trim())
                            .filter(Boolean),
                        ),
                      ];
                      const invalid = urls.filter((u) => {
                        try {
                          new URL(u);
                          return false;
                        } catch {
                          return true;
                        }
                      });
                      if (urls.length === 0) {
                        toast.error("Paste at least one URL");
                        return;
                      }
                      if (invalid.length > 0) {
                        toast.error(
                          `${invalid.length} line(s) aren't valid URLs — add https:// to each`,
                        );
                        return;
                      }
                      if (urls.length > 50) {
                        toast.error("Max 50 URLs at a time");
                        return;
                      }
                      setBulkResults(null);
                      bulkAddMut.mutate(urls);
                    }}
                    className="space-y-3"
                  >
                    <Textarea
                      value={bulkText}
                      onChange={(e) => setBulkText(e.target.value)}
                      placeholder={"https://blog-one.example\nhttps://blog-two.example/feed\nhttps://another-site.example"}
                      className="min-h-32 font-mono text-xs"
                      autoFocus
                    />
                    <p className="text-xs text-muted-foreground">
                      One URL per line (or comma-separated). Each is added with its
                      default settings — real feeds import as-is, and scraped pages
                      keep every article link found.
                    </p>
                    {bulkResults && (
                      <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                        {bulkResults.map((r) => (
                          <div key={r.url} className="flex items-start gap-2 text-xs">
                            <span
                              className={
                                r.ok ? "text-primary" : "text-destructive"
                              }
                            >
                              {r.ok ? "✓" : "✗"}
                            </span>
                            <span className="min-w-0 flex-1 truncate">
                              {r.ok ? r.title || r.url : `${r.url} — ${r.error}`}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <DialogFooter>
                      <Button type="submit" disabled={bulkAddMut.isPending || !bulkText.trim()}>
                        {bulkAddMut.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <ListPlus className="mr-2 h-4 w-4" />
                        )}
                        Add feeds
                      </Button>
                    </DialogFooter>
                  </form>
                )}
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 font-display text-2xl">
                    <button
                      type="button"
                      onClick={() => {
                        setSetupFeed(null);
                        setSetupSelected({});
                      }}
                      className="rounded p-1 text-muted-foreground hover:bg-muted"
                      aria-label="Back"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    Confirm the articles
                  </DialogTitle>
                </DialogHeader>
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{setupFeed.title}</span>{" "}
                  isn't a real RSS feed, so we scraped its links. Uncheck anything
                  that isn't an article — we'll remember the pattern for future
                  refreshes.
                </p>
                <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                  {setupFeed.items.length === 0 ? (
                    <p className="p-3 text-center text-xs text-muted-foreground">
                      No article-like links found on that page.
                    </p>
                  ) : (
                    setupFeed.items.map((it) => (
                      <label
                        key={it.link}
                        className="flex items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={!!setupSelected[it.link]}
                          onCheckedChange={(v) =>
                            setSetupSelected((prev) => ({ ...prev, [it.link]: !!v }))
                          }
                        />
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 block">{it.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {it.link}
                          </span>
                        </span>
                      </label>
                    ))
                  )}
                </div>
                <DialogFooter>
                  <span className="mr-auto text-xs text-muted-foreground">
                    {Object.values(setupSelected).filter(Boolean).length} selected
                  </span>
                  <Button
                    onClick={() =>
                      addMut.mutate({
                        url: newUrl,
                        selectedLinks: Object.keys(setupSelected).filter(
                          (k) => setupSelected[k],
                        ),
                      })
                    }
                    disabled={
                      addMut.isPending ||
                      Object.values(setupSelected).filter(Boolean).length === 0
                    }
                  >
                    {addMut.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="mr-2 h-4 w-4" />
                    )}
                    Add feed
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <nav className="mt-4 flex-1 overflow-y-auto px-2 pb-4">
        <button
          onClick={() => setSelected("__all__")}
          className={`group flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
            selected === "__all__"
              ? "bg-primary/15 text-foreground"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          <span className="flex items-center gap-2">
            <Inbox className="h-4 w-4" />
            All feeds
          </span>
          {totalUnread > 0 && (
            <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
              {totalUnread}
            </span>
          )}
        </button>

        <div className="mt-4 mb-1 px-3 text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
          Feeds ({feeds.length})
        </div>

        {feeds.length > 4 && (
          <div className="relative mb-2 px-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={feedFilter}
              onChange={(e) => setFeedFilter(e.target.value)}
              placeholder="Filter feeds…"
              className="h-8 pl-8 text-xs"
            />
          </div>
        )}

        {feedsQuery.isLoading ? (
          <div className="p-3 text-xs text-muted-foreground">Loading…</div>
        ) : feeds.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
            No feeds yet. Add one above.
          </div>
        ) : filteredFeeds.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
            No feeds match "{feedFilter}".
          </div>
        ) : (
          <ul className="space-y-0.5">
            {filteredFeeds.map((f) => (
              <li key={f.id} className="group flex items-stretch">
                <button
                  onClick={() => setSelected(f.id)}
                  className={`flex flex-1 items-center justify-between gap-2 overflow-hidden rounded-l-lg px-3 py-2.5 text-left text-sm transition ${
                    selected === f.id
                      ? "bg-primary/15 text-foreground"
                      : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Rss className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                    <span className="truncate">{f.title || f.url}</span>
                  </span>
                  {(f.unread_count ?? 0) > 0 && (
                    <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-accent-foreground">
                      {f.unread_count}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete "${f.title || f.url}"?`)) delMut.mutate(f.id);
                  }}
                  className="rounded-r-lg px-2 text-muted-foreground opacity-70 hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100"
                  aria-label="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="border-t border-border p-3 text-[10px] text-muted-foreground">
        <Sparkles className="mr-1 inline h-3 w-3 text-primary sparkle" />
        Auto-refreshes every 5 min
      </div>
    </div>
  );

  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-[260px_1fr]">
      <Toaster richColors position="top-center" />

      {/* Sidebar: static on desktop, a slide-over drawer on mobile */}
      <aside className="hidden border-r border-border bg-card/40 backdrop-blur md:flex md:flex-col">
        {sidebarContent}
      </aside>
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-[85vw] max-w-[300px] p-0 md:hidden">
          {sidebarContent}
        </SheetContent>
      </Sheet>

      {/* Main */}
      <main className="flex min-h-screen min-w-0 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card/40 p-3 backdrop-blur sm:p-4">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              size="icon"
              variant="ghost"
              className="shrink-0 md:hidden"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open feeds menu"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <div className="min-w-0">
              <h1 className="truncate font-display text-xl sm:text-2xl">
                {selected === "__all__" ? "All feeds" : selectedFeed?.title ?? "Feed"}
              </h1>
              <p className="truncate text-xs text-muted-foreground">
                {items.length} items shown
                {selectedFeed?.last_refreshed_at && (
                  <>
                    {" · updated "}
                    {new Date(selectedFeed.last_refreshed_at).toLocaleTimeString()}
                  </>
                )}
                {selectedFeed?.last_error && (
                  <span className="ml-2 rounded bg-destructive/15 px-1.5 py-0.5 text-destructive">
                    {selectedFeed.last_error}
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={itemSearchInput}
                onChange={(e) => setItemSearchInput(e.target.value)}
                placeholder="Search articles…"
                className="h-8 w-36 pl-8 pr-7 text-xs sm:w-52"
              />
              {itemSearchInput && (
                <button
                  type="button"
                  onClick={() => setItemSearchInput("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={unreadOnly}
                onCheckedChange={(v) => setUnreadOnlyPersisted(!!v)}
              />
              Unread only
            </label>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                refreshMut.mutate(selected === "__all__" ? undefined : selected)
              }
              disabled={refreshMut.isPending}
            >
              <RefreshCw
                className={`h-4 w-4 sm:mr-2 ${refreshMut.isPending ? "animate-spin" : ""}`}
              />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                markAllMut.mutate(selected === "__all__" ? null : selected)
              }
            >
              <CheckCheck className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Mark all read</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (
                  confirm(
                    "Delete every already-read item" +
                      (selected === "__all__" ? "" : " in this feed") +
                      "? They won't come back next refresh.",
                  )
                ) {
                  delReadMut.mutate(selected === "__all__" ? null : selected);
                }
              }}
              disabled={delReadMut.isPending}
            >
              <Trash2 className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Delete read</span>
            </Button>
          </div>
        </div>

        {checkedIds.length > 0 && (
          <div className="flex items-center justify-between border-b border-border bg-primary/5 px-3 py-2 text-sm sm:px-4">
            <span>{checkedIds.length} selected</span>
            <div className="flex gap-1 sm:gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => markMut.mutate({ ids: checkedIds, read: true })}
              >
                <CircleCheck className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Mark read</span>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => markMut.mutate({ ids: checkedIds, read: false })}
              >
                <Circle className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Mark unread</span>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  if (confirm(`Delete ${checkedIds.length} item(s)?`)) {
                    delItemsMut.mutate(checkedIds);
                  }
                }}
              >
                <Trash2 className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Delete</span>
              </Button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {itemsQuery.isLoading ? (
            <div className="flex items-center justify-center p-12 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="p-12 text-center text-sm text-muted-foreground">
              {itemSearch
                ? `No articles match "${itemSearch}".`
                : feeds.length === 0
                  ? "Add your first feed to start collecting articles."
                  : unreadOnly
                    ? "All caught up ✦"
                    : "No items yet — try refreshing."}
            </div>
          ) : (
            <>
              {/* Select-all row */}
              <div className="flex items-center gap-3 border-b border-border px-3 py-2 sm:px-4">
                <Checkbox
                  checked={allChecked}
                  onCheckedChange={(v) => {
                    if (v) {
                      const next: Record<string, boolean> = {};
                      for (const it of items) next[it.id] = true;
                      setChecked(next);
                    } else setChecked({});
                  }}
                  aria-label="Select all"
                />
                <span className="text-xs text-muted-foreground">Select all</span>
              </div>

              <ul className="divide-y divide-border">
                {items.map((it: any, index: number) => {
                  const isRead = it.is_read;
                  return (
                    <li
                      key={it.id}
                      className={`flex items-start gap-2 px-3 py-3 sm:gap-3 sm:px-4 ${
                        isRead ? "opacity-55" : ""
                      }`}
                    >
                      <Checkbox
                        className="mt-1 shrink-0"
                        checked={!!checked[it.id]}
                        onCheckedChange={(v) => toggleRow(it.id, !!v)}
                        aria-label="Select item"
                      />

                      <a
                        href={it.link}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => {
                          if (!isRead) markMut.mutate({ ids: [it.id], read: true });
                        }}
                        className="min-w-0 flex-1 hover:text-primary"
                      >
                        <div
                          className={`flex items-start gap-1.5 text-sm ${
                            isRead ? "font-normal" : "font-semibold"
                          }`}
                        >
                          <span className="line-clamp-2">{it.title}</span>
                          <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 opacity-50" />
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          {selected === "__all__" && (
                            <span
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setSelected(it.feed_id);
                              }}
                              className="truncate hover:text-primary hover:underline"
                            >
                              {it.feeds?.title ?? "—"}
                            </span>
                          )}
                          {selected === "__all__" && <span>·</span>}
                          <span className="whitespace-nowrap">
                            {new Date(it.pub_date ?? it.created_at).toLocaleDateString()}
                          </span>
                        </div>
                      </a>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="mt-0.5 h-7 w-7 shrink-0"
                            aria-label="Item actions"
                          >
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() =>
                              markMut.mutate({ ids: [it.id], read: !isRead })
                            }
                          >
                            {isRead ? (
                              <Circle className="mr-2 h-4 w-4" />
                            ) : (
                              <CircleCheck className="mr-2 h-4 w-4" />
                            )}
                            Mark {isRead ? "unread" : "read"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => markRelative(index, "above")}
                            disabled={index === 0}
                          >
                            <ArrowUpToLine className="mr-2 h-4 w-4" />
                            Mark above as read
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => markRelative(index, "below")}
                            disabled={index === items.length - 1}
                          >
                            <ArrowDownToLine className="mr-2 h-4 w-4" />
                            Mark below as read
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => delItemsMut.mutate([it.id])}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
