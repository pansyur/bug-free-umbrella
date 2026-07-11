import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast, Toaster } from "sonner";
import {
  Rss,
  Loader2,
  Link as LinkIcon,
  Copy,
  Save,
  Trash2,
  ExternalLink,
  Sparkles,
  Wand2,
  MoreHorizontal,
  Check,
  CheckCheck,
  ArrowUpToLine,
  ArrowDownToLine,
  RotateCcw,
  RefreshCw,
  WifiOff,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { previewFeed } from "@/lib/feed.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Fae Feeds — enchant any website into an RSS feed" },
      {
        name: "description",
        content:
          "A whimsical little scriptorium that turns any URL into a subscribable RSS feed. Auto-refreshes every 5 minutes, works offline from cache.",
      },
      { property: "og:title", content: "Fae Feeds — enchant any website into an RSS feed" },
      {
        property: "og:description",
        content:
          "A whimsical little scriptorium that turns any URL into a subscribable RSS feed. Auto-refreshes every 5 minutes, works offline from cache.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

interface SavedFeed {
  id: string;
  url: string;
  title: string;
  savedAt: number;
}

interface FeedItem {
  title: string;
  link: string;
  description?: string;
  pubDate?: string;
}

interface ExtractedFeed {
  title: string;
  description: string;
  items: FeedItem[];
}

interface CachedFeed {
  feed: ExtractedFeed;
  fetchedAt: number;
  offline?: boolean;
}

const STORAGE_KEY = "faefeeds.saved.v1";
const READ_KEY = "faefeeds.read.v1";
const CACHE_KEY = "faefeeds.cache.v1";
const REFRESH_MS = 5 * 60 * 1000;

function loadJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key: string, val: unknown) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(val));
}

function Sprite({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute sparkle text-primary/70 ${className}`}
    >
      <Sparkles className="h-4 w-4" />
    </span>
  );
}

function Home() {
  const [url, setUrl] = useState("");
  const [saved, setSaved] = useState<SavedFeed[]>([]);
  const [read, setRead] = useState<Record<string, true>>({});
  const [cache, setCache] = useState<Record<string, CachedFeed>>({});
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const preview = useServerFn(previewFeed);
  const refreshingRef = useRef(false);

  useEffect(() => {
    setSaved(loadJSON<SavedFeed[]>(STORAGE_KEY, []));
    setRead(loadJSON<Record<string, true>>(READ_KEY, {}));
    setCache(loadJSON<Record<string, CachedFeed>>(CACHE_KEY, {}));
  }, []);

  const mutation = useMutation({
    mutationFn: (u: string) => preview({ data: { url: u } }),
    onSuccess: (data, u) => {
      setActiveUrl(u);
      updateCache(u, { feed: data, fetchedAt: Date.now(), offline: false });
    },
    onError: (e: Error, u) => {
      const existing = cache[u];
      if (existing) {
        setActiveUrl(u);
        updateCache(u, { ...existing, offline: true });
        toast.warning("Offline — showing last cached feed");
      } else {
        toast.error(e.message || "The fairies couldn't reach that page");
      }
    },
  });

  function updateCache(u: string, entry: CachedFeed) {
    setCache((prev) => {
      const next = { ...prev, [u]: entry };
      saveJSON(CACHE_KEY, next);
      return next;
    });
  }

  const feed = activeUrl ? cache[activeUrl]?.feed : undefined;
  const feedMeta = activeUrl ? cache[activeUrl] : undefined;

  const refreshAll = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    const urls = new Set<string>();
    if (activeUrl) urls.add(activeUrl);
    for (const s of saved) urls.add(s.url);
    for (const u of urls) {
      try {
        const data = await preview({ data: { url: u } });
        updateCache(u, { feed: data, fetchedAt: Date.now(), offline: false });
      } catch {
        setCache((prev) => {
          const existing = prev[u];
          if (!existing) return prev;
          const next = { ...prev, [u]: { ...existing, offline: true } };
          saveJSON(CACHE_KEY, next);
          return next;
        });
      }
    }
    setNow(Date.now());
    refreshingRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUrl, saved]);

  // Auto refresh every 5 minutes, even without network (tries + falls back to cache)
  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshAll();
    }, REFRESH_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    const onFocus = () => setNow(Date.now());
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.clearInterval(tick);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshAll]);

  function updateRead(next: Record<string, true>) {
    setRead(next);
    saveJSON(READ_KEY, next);
  }
  function toggleRead(link: string) {
    const next = { ...read };
    if (next[link]) delete next[link];
    else next[link] = true;
    updateRead(next);
  }
  function markRange(links: string[], value: boolean) {
    const next = { ...read };
    for (const l of links) {
      if (value) next[l] = true;
      else delete next[l];
    }
    updateRead(next);
  }

  const unreadCount = feed
    ? feed.items.filter((i) => !read[i.link]).length
    : 0;

  const rssUrl = useMemo(() => {
    if (typeof window === "undefined" || !url) return "";
    try {
      new URL(url);
      return `${window.location.origin}/api/public/rss?url=${encodeURIComponent(url)}`;
    } catch {
      return "";
    }
  }, [url]);

  function persist(next: SavedFeed[]) {
    setSaved(next);
    saveJSON(STORAGE_KEY, next);
  }

  function handleSave() {
    const u = activeUrl ?? url;
    if (!feed || !u) return;
    if (saved.some((s) => s.url === u)) {
      toast.info("Already tucked into your grimoire");
      return;
    }
    persist([
      { id: crypto.randomUUID(), url: u, title: feed.title, savedAt: Date.now() },
      ...saved,
    ]);
    toast.success("Sealed with a fae wax stamp ✦");
  }

  function handleDelete(id: string) {
    persist(saved.filter((s) => s.id !== id));
  }

  function openSaved(u: string) {
    setUrl(u);
    setActiveUrl(u);
    if (!cache[u]) mutation.mutate(u);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Whispered to your clipboard");
    } catch {
      toast.error("Couldn't copy");
    }
  }

  function formatAge(ts: number) {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return `${h}h ago`;
  }

  return (
    <div className="min-h-screen">
      <Toaster richColors position="top-center" />

      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[500px] w-[900px] -translate-x-1/2 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-[400px] w-[600px] rounded-full bg-accent/40 blur-3xl" />
        <div className="absolute top-1/3 -left-20 h-[300px] w-[300px] rounded-full bg-secondary/60 blur-3xl" />
      </div>

      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2.5">
          <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-primary-foreground fairy-glow">
            <Wand2 className="h-5 w-5" />
            <Sparkles className="absolute -right-1 -top-1 h-3 w-3 text-accent-foreground sparkle" />
          </div>
          <div>
            <span className="font-display text-xl font-semibold tracking-tight">
              Fae Feeds
            </span>
            <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              a little scriptorium
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/reader"
            className="rounded-full border border-border bg-card/70 px-3 py-1.5 text-xs font-medium text-foreground backdrop-blur transition hover:bg-primary hover:text-primary-foreground"
          >
            Open reader →
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-24">
        <section className="relative pt-8 text-center sm:pt-14">
          <Sprite className="left-[15%] top-2" />
          <Sprite className="right-[18%] top-10" />
          <Sprite className="left-[8%] bottom-0" />

          <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
            <Sparkles className="h-3 w-3 text-primary" />
            Any URL. A little pixie dust. A living feed.
          </div>
          <h1 className="mt-5 font-display text-5xl italic sm:text-6xl">
            Whisper a URL,
            <br />
            <span className="fairy-text not-italic font-semibold">receive a feed</span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-balance text-muted-foreground">
            Paste any link. We'll flutter over, gather the articles, and tuck them
            into an RSS scroll — refreshed every 5 minutes, readable even when
            the wifi wanders off.
          </p>
        </section>

        <Card className="mt-10 border-border/60 bg-card/80 p-4 shadow-xl fairy-glow backdrop-blur sm:p-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              try {
                new URL(url);
              } catch {
                toast.error("Add https:// to the beginning");
                return;
              }
              mutation.mutate(url);
            }}
            className="flex flex-col gap-3 sm:flex-row"
          >
            <div className="relative flex-1">
              <LinkIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://a-lovely-blog.example"
                className="h-12 pl-9 text-base"
                inputMode="url"
                autoComplete="url"
              />
            </div>
            <Button
              type="submit"
              size="lg"
              className="h-12 px-6"
              disabled={mutation.isPending || !url}
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Fluttering…
                </>
              ) : (
                <>
                  <Wand2 className="mr-2 h-4 w-4" />
                  Cast feed
                </>
              )}
            </Button>
          </form>

          {rssUrl && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 p-2.5">
              <span className="rounded bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                RSS
              </span>
              <code className="flex-1 truncate text-xs text-muted-foreground">
                {rssUrl}
              </code>
              <Button size="sm" variant="ghost" onClick={() => copy(rssUrl)}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </Card>

        {feed && (
          <Card className="mt-6 overflow-hidden border-border/60 bg-card/85 backdrop-blur">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-5">
              <div className="min-w-0">
                <h2 className="truncate font-display text-2xl">{feed.title}</h2>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {feed.description}
                </p>
                <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    <span className="font-semibold text-foreground">{feed.items.length}</span> items ·{" "}
                    <span className="font-semibold text-primary">{unreadCount}</span> unread
                  </span>
                  {feedMeta && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                      <RefreshCw className="h-3 w-3" />
                      {formatAge(feedMeta.fetchedAt)}
                    </span>
                  )}
                  {feedMeta?.offline && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-accent/50 px-2 py-0.5 text-accent-foreground">
                      <WifiOff className="h-3 w-3" />
                      offline cache
                    </span>
                  )}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => activeUrl && mutation.mutate(activeUrl)}
                  variant="outline"
                  size="sm"
                  disabled={mutation.isPending}
                >
                  <RefreshCw className={`mr-2 h-4 w-4 ${mutation.isPending ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
                <Button
                  onClick={() =>
                    markRange(feed.items.map((i) => i.link), true)
                  }
                  variant="outline"
                  size="sm"
                >
                  <CheckCheck className="mr-2 h-4 w-4" />
                  Mark all read
                </Button>
                <Button
                  onClick={() =>
                    markRange(feed.items.map((i) => i.link), false)
                  }
                  variant="ghost"
                  size="sm"
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Reset
                </Button>
                <Button onClick={handleSave} variant="secondary" size="sm">
                  <Save className="mr-2 h-4 w-4" />
                  Keep
                </Button>
              </div>
            </div>

            {feed.items.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                No article-like links found on that page.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {feed.items.map((item, i) => {
                    const isRead = !!read[item.link];
                    return (
                      <TableRow
                        key={item.link}
                        data-read={isRead}
                        className={isRead ? "opacity-55" : ""}
                      >
                        <TableCell className="align-top">
                          <Checkbox
                            checked={isRead}
                            onCheckedChange={() => toggleRead(item.link)}
                            aria-label={isRead ? "Mark unread" : "Mark read"}
                          />
                        </TableCell>
                        <TableCell className="align-top font-mono text-xs text-muted-foreground">
                          {String(i + 1).padStart(2, "0")}
                        </TableCell>
                        <TableCell className="align-top">
                          <a
                            href={item.link}
                            target="_blank"
                            rel="noreferrer"
                            onClick={() => {
                              if (!isRead) toggleRead(item.link);
                            }}
                            className={`line-clamp-2 text-sm hover:text-primary ${
                              isRead ? "font-normal" : "font-semibold"
                            }`}
                          >
                            {item.title}
                          </a>
                          <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                            <ExternalLink className="h-3 w-3 shrink-0" />
                            <span className="truncate">{item.link}</span>
                          </p>
                        </TableCell>
                        <TableCell className="align-top">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="icon" variant="ghost" className="h-8 w-8">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-52">
                              <DropdownMenuItem onClick={() => toggleRead(item.link)}>
                                <Check className="mr-2 h-4 w-4" />
                                {isRead ? "Mark as unread" : "Mark as read"}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() =>
                                  markRange(
                                    feed.items.slice(0, i + 1).map((x) => x.link),
                                    true,
                                  )
                                }
                              >
                                <ArrowUpToLine className="mr-2 h-4 w-4" />
                                Mark this &amp; above read
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  markRange(
                                    feed.items.slice(i).map((x) => x.link),
                                    true,
                                  )
                                }
                              >
                                <ArrowDownToLine className="mr-2 h-4 w-4" />
                                Mark this &amp; below read
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Card>
        )}

        <section className="mt-12">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-lg italic text-muted-foreground">
              Your grimoire of feeds
            </h3>
            <span className="text-xs text-muted-foreground">{saved.length}</span>
          </div>
          {saved.length === 0 ? (
            <Card className="border-dashed bg-card/60 p-8 text-center text-sm text-muted-foreground backdrop-blur">
              Feeds you keep appear here — tucked into your browser like pressed flowers.
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {saved.map((s) => {
                const rss = `${typeof window !== "undefined" ? window.location.origin : ""}/api/public/rss?url=${encodeURIComponent(s.url)}`;
                const c = cache[s.url];
                return (
                  <Card key={s.id} className="flex flex-col gap-3 bg-card/85 p-4 backdrop-blur">
                    <div className="flex items-start justify-between gap-2">
                      <button
                        onClick={() => openSaved(s.url)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="truncate font-display text-base font-semibold">{s.title}</p>
                        <p className="truncate text-xs text-muted-foreground">{s.url}</p>
                        {c && (
                          <p className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                            <RefreshCw className="h-2.5 w-2.5" />
                            {formatAge(c.fetchedAt)}
                            {c.offline && (
                              <span className="inline-flex items-center gap-1 text-accent-foreground/80">
                                · <WifiOff className="h-2.5 w-2.5" /> cached
                              </span>
                            )}
                          </p>
                        )}
                      </button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleDelete(s.id)}
                        aria-label="Remove"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        className="flex-1"
                        onClick={() => copy(rss)}
                      >
                        <Copy className="mr-2 h-3.5 w-3.5" />
                        Copy RSS
                      </Button>
                      <Button size="sm" variant="outline" asChild>
                        <a href={rss} target="_blank" rel="noreferrer">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        <footer className="mt-16 text-center text-xs text-muted-foreground">
          <Sparkles className="mx-auto mb-2 h-3 w-3 text-primary sparkle" />
          Woven with pixie dust · feeds refresh themselves every 5 minutes
        </footer>
      </main>
    </div>
  );
}
