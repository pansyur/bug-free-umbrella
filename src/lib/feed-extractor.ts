// Shared HTML→feed extraction logic. Runs server-side only.

export interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

export interface ExtractedFeed {
  title: string;
  description: string;
  link: string;
  items: FeedItem[];
  /**
   * True when `sourceUrl` was a genuine RSS/Atom XML document (either
   * directly, or discovered via a <link rel="alternate"> tag on an HTML
   * page). False means `items` came from best-effort HTML scraping, in
   * which case the caller should let the user confirm/curate which links
   * are actually articles before saving the feed.
   */
  isRealFeed: boolean;
}

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function absoluteUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a URL directly, retrying once with a short backoff if the site
 * responds with 429 (rate limited) — a lot of sites just need a beat before
 * they'll answer again.
 */
async function tryFetchDirect(url: string): Promise<{ text?: string; status?: number }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
      if (res.ok) return { text: await res.text() };
      if (res.status === 429 && attempt === 0) {
        await sleep(1200 + Math.random() * 800);
        continue;
      }
      return { status: res.status };
    } catch {
      // Network-level failure (DNS, TLS, timeout) — let the caller fall
      // back to a proxy instead of retrying the same dead end.
      return {};
    }
  }
  return {};
}

/** Try a single proxy URL, retrying once on 429. Throws with a short reason
 * on failure so the caller can report what actually happened. */
async function tryFetchProxy(proxyUrl: string): Promise<string> {
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(proxyUrl, {
      headers: { "User-Agent": BROWSER_HEADERS["User-Agent"], Accept: "text/html,*/*" },
    });
    if (res.ok) return await res.text();
    lastStatus = res.status;
    if (res.status === 429 && attempt === 0) {
      await sleep(1200 + Math.random() * 800);
      continue;
    }
    break;
  }
  throw new Error(`proxy returned ${lastStatus}`);
}

/**
 * Fetch a page's HTML, working around the two most common failure modes for
 * "add this URL as a feed": the site rate-limiting us (429) or blocking
 * non-browser requests (403/503). We retry the direct request briefly, then
 * fall back to a couple of read-only rendering proxies before giving up with
 * a message that explains what actually happened.
 */
async function fetchWithBypass(url: string): Promise<string> {
  const direct = await tryFetchDirect(url);
  if (direct.text !== undefined) return direct.text;

  // Only worth trying a proxy for statuses that usually mean "blocking
  // automation" — not things like 404/410 that a proxy won't fix.
  if (direct.status !== undefined && ![403, 429, 503].includes(direct.status)) {
    throw new Error(
      `That page returned a ${direct.status} — double check the URL is correct and publicly reachable.`,
    );
  }

  const proxies = [
    `https://r.jina.ai/${url}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];

  const failures: string[] = direct.status ? [`direct request: ${direct.status}`] : [];
  for (const proxyUrl of proxies) {
    try {
      return await tryFetchProxy(proxyUrl);
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }

  throw new Error(
    `Couldn't fetch that page after retrying (${failures.join("; ")}). The site is likely ` +
      `rate-limiting or blocking automated requests right now — wait a bit and try again.`,
  );
}

function extractMeta(html: string, prop: string): string | undefined {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`,
      "i",
    ),
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return decodeEntities(m[1]);
  }
  return undefined;
}

function cdataOrText(raw: string | undefined): string {
  if (!raw) return "";
  const cdata = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  const inner = cdata ? cdata[1] : raw;
  return stripTags(decodeEntities(inner));
}

function tagContent(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1] : undefined;
}

/**
 * Try to parse the fetched document as a real RSS or Atom XML feed. Returns
 * null if it doesn't look like one, so callers can fall back to HTML
 * scraping. This is the path that gives correctly-named items for sites
 * that actually publish a feed, since it reads the true <title> per item
 * instead of guessing from link text.
 */
function tryParseXmlFeed(xml: string, sourceUrl: string): ExtractedFeed | null {
  const looksLikeXml = /<rss[\s>]/i.test(xml) || /<feed[\s>]/i.test(xml) || /<\?xml/i.test(xml);
  if (!looksLikeXml) return null;
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);

  const channelTitle = isAtom
    ? cdataOrText(tagContent(xml, "title"))
    : cdataOrText(tagContent(xml.match(/<channel\b[\s\S]*?<\/channel>/i)?.[0] ?? xml, "title"));
  const channelDesc = cdataOrText(
    tagContent(xml, isAtom ? "subtitle" : "description"),
  );

  const entryRegex = isAtom
    ? /<entry\b[\s\S]*?<\/entry>/gi
    : /<item\b[\s\S]*?<\/item>/gi;

  const items: FeedItem[] = [];
  let m: RegExpExecArray | null;
  while ((m = entryRegex.exec(xml)) !== null) {
    const block = m[0];
    const title = cdataOrText(tagContent(block, "title"));
    let link: string | undefined;
    if (isAtom) {
      const linkMatch =
        block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ||
        block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
      link = linkMatch?.[1];
    } else {
      link = cdataOrText(tagContent(block, "link"));
      if (!link) {
        const guid = tagContent(block, "guid");
        if (guid && /^https?:\/\//i.test(guid)) link = decodeEntities(guid.trim());
      }
    }
    if (!title || !link) continue;

    const description =
      cdataOrText(tagContent(block, isAtom ? "summary" : "description")) || title;
    const pubDateRaw =
      tagContent(block, "pubDate") ||
      tagContent(block, "published") ||
      tagContent(block, "updated");
    const pubDate = pubDateRaw ? new Date(pubDateRaw.trim()).toUTCString() : undefined;

    items.push({
      title,
      link: absoluteUrl(link.trim(), sourceUrl),
      description,
      pubDate: pubDate && pubDate !== "Invalid Date" ? pubDate : undefined,
    });
    if (items.length >= 100) break;
  }

  if (items.length === 0) return null;

  return {
    title: channelTitle || sourceUrl,
    description: channelDesc || `Feed for ${sourceUrl}`,
    link: sourceUrl,
    items: sortNewestFirst(items),
    isRealFeed: true,
  };
}

/** Newest-first, by pub date when we have one, otherwise items keep their
 * scraped/document order (falls to the end). */
function sortNewestFirst(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => {
    const ta = a.pubDate ? Date.parse(a.pubDate) : NaN;
    const tb = b.pubDate ? Date.parse(b.pubDate) : NaN;
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  });
}

/**
 * Given a set of links the user confirmed are "real" articles for a scraped
 * (non-RSS) page, derive a common leading path segment (e.g. "/blog") that
 * future scrapes can filter on, so nav/category/footer links don't sneak in
 * as items.
 */
export function derivePathPrefix(links: string[]): string | undefined {
  const paths: string[][] = [];
  for (const link of links) {
    try {
      const u = new URL(link);
      const segments = u.pathname.split("/").filter(Boolean);
      if (segments.length > 1) paths.push(segments.slice(0, -1));
    } catch {
      // ignore invalid urls
    }
  }
  if (paths.length === 0) return undefined;

  const shortest = Math.min(...paths.map((p) => p.length));
  const common: string[] = [];
  for (let i = 0; i < shortest; i++) {
    const seg = paths[0][i];
    if (paths.every((p) => p[i] === seg)) common.push(seg);
    else break;
  }
  if (common.length === 0) return undefined;
  return `/${common.join("/")}`;
}

/** Filters scraped items down to ones whose link path starts with the
 * remembered prefix. No-op (returns items unchanged) if there's no prefix,
 * or if applying it would wipe out every item (site structure changed). */
export function filterByPathPrefix(
  items: FeedItem[],
  pathPrefix: string | null | undefined,
): FeedItem[] {
  if (!pathPrefix) return items;
  const filtered = items.filter((it) => {
    try {
      return new URL(it.link).pathname.startsWith(pathPrefix);
    } catch {
      return false;
    }
  });
  return filtered.length > 0 ? filtered : items;
}

function discoverFeedLink(html: string, sourceUrl: string): string | undefined {
  // <link rel="alternate" type="application/rss+xml" href="...">
  const linkTagRegex = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkTagRegex.exec(html)) !== null) {
    const tag = m[0];
    if (!/rel=["'][^"']*alternate[^"']*["']/i.test(tag)) continue;
    if (!/type=["'](application\/(?:rss|atom)\+xml|application\/xml|text\/xml)["']/i.test(tag))
      continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (href) return absoluteUrl(href, sourceUrl);
  }
  return undefined;
}

function originOf(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).origin;
  } catch {
    return "";
  }
}

function isSkippableListingPath(pathname: string): boolean {
  return /\/(tag|category|author|page|search|login|signup|about|contact|privacy|terms)(\/|$)/i.test(
    pathname,
  );
}

/**
 * Listing/index pages almost always wrap each article's title in a heading
 * tag (h1–h4) that links to the article — this is exactly the "item +
 * heading + link" structure that tools like rsspls ask a person to specify
 * by hand with CSS selectors (see https://github.com/wezm/rsspls). We get
 * the same precision without per-site config by scanning for that pattern
 * directly: it reliably separates real article titles from nav/footer/
 * category links, which a flat scan of every `<a>` tag cannot do.
 *
 * For each match we also look at a short window of HTML right after the
 * heading — where listing pages conventionally place the date and a teaser
 * paragraph — to fill in `pubDate` and `description` when possible.
 */
function extractHeadingLinkedItems(html: string, sourceUrl: string): FeedItem[] {
  const origin = originOf(sourceUrl);
  const items: FeedItem[] = [];
  const seen = new Set<string>();

  const headingRegex = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi;
  let m: RegExpExecArray | null;
  while ((m = headingRegex.exec(html)) !== null) {
    const headingInner = m[1];
    const anchorMatch = headingInner.match(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!anchorMatch) continue;

    const rawHref = anchorMatch[1];
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) continue;
    const href = absoluteUrl(rawHref, sourceUrl);
    try {
      const u = new URL(href);
      if (origin && u.origin !== origin) continue;
      if (isSkippableListingPath(u.pathname)) continue;
      if (u.pathname === "/" || u.pathname === "" || u.href === sourceUrl) continue;
    } catch {
      continue;
    }

    const title = stripTags(anchorMatch[2]) || stripTags(headingInner);
    if (!title || title.length < 4 || title.length > 220) continue;
    if (seen.has(href)) continue;
    seen.add(href);

    // Look just past the heading for a date and teaser paragraph, the way
    // rsspls's `date` / `summary` selectors do relative to its `item`.
    const windowEnd = Math.min(html.length, headingRegex.lastIndex + 1500);
    const after = html.slice(headingRegex.lastIndex, windowEnd);

    let pubDate: string | undefined;
    const timeDatetime = after.match(/<time\b[^>]*\bdatetime=["']([^"']+)["']/i);
    const timeText = after.match(/<time\b[^>]*>([\s\S]*?)<\/time>/i);
    const rawDate = timeDatetime?.[1] ?? (timeText ? stripTags(timeText[1]) : undefined);
    if (rawDate) {
      const d = new Date(rawDate.trim());
      if (!Number.isNaN(d.getTime())) pubDate = d.toUTCString();
    }

    const pMatch = after.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    const description = (pMatch ? stripTags(pMatch[1]) : "") || title;

    items.push({ title, link: href, description, pubDate });
    if (items.length >= 30) break;
  }

  return items;
}

/** Last-resort fallback: scan every `<a>` on the page. Much noisier than
 * heading-based extraction (nav/footer links slip through), so it's only
 * used when the page doesn't wrap article titles in headings at all. */
function extractAnyLinkedItems(html: string, sourceUrl: string): FeedItem[] {
  const origin = originOf(sourceUrl);
  const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  const items: FeedItem[] = [];

  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html)) !== null) {
    const rawHref = m[1];
    const fullTag = m[0];
    const inner = m[2];
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) continue;

    const href = absoluteUrl(rawHref, sourceUrl);
    try {
      const u = new URL(href);
      if (origin && u.origin !== origin) continue;
      if (isSkippableListingPath(u.pathname)) continue;
      if (u.pathname === "/" || u.pathname === "") continue;
      if (u.href === sourceUrl) continue;
    } catch {
      continue;
    }

    const attrTitle =
      fullTag.match(/\btitle=["']([^"']+)["']/i)?.[1] ||
      fullTag.match(/\baria-label=["']([^"']+)["']/i)?.[1];
    const title = decodeEntities(attrTitle?.trim() || "") || stripTags(inner);
    if (!title || title.length < 15 || title.length > 220) continue;
    if (seen.has(href)) continue;
    seen.add(href);

    items.push({ title, link: href, description: title, pubDate: undefined });
    if (items.length >= 30) break;
  }

  return items;
}

/**
 * Some sites render their article list entirely client-side (React/Vue/
 * Next.js/Substack-style SPAs) — the static HTML we fetch is just an empty
 * shell with no real links in it, which is why scraping can come up with
 * nothing (or just the page's own meta tags as a single fake "item"). As a
 * fallback we re-fetch through r.jina.ai's reader, which executes the page's
 * JS before handing back content, and returns it as clean markdown rather
 * than HTML — so it needs its own link extractor.
 */
async function fetchRenderedViaReader(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { "User-Agent": BROWSER_HEADERS["User-Agent"], Accept: "text/plain,*/*" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Extract `[title](url)` style links from the reader proxy's markdown
 * output. Mirrors extractAnyLinkedItems' filtering, since a rendered SPA
 * page still has nav/footer links mixed in with the real article ones. */
function extractMarkdownLinkedItems(markdown: string, sourceUrl: string): FeedItem[] {
  const origin = originOf(sourceUrl);
  const items: FeedItem[] = [];
  const seen = new Set<string>();

  const linkRegex = /\[([^\]]{8,220})\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(markdown)) !== null) {
    // Skip markdown images: ![alt](url) — the "!" sits right before the "[".
    if (m.index > 0 && markdown[m.index - 1] === "!") continue;

    const rawTitle = m[1].trim();
    const rawHref = m[2].trim();
    if (!rawHref || rawHref.startsWith("#")) continue;

    const href = absoluteUrl(rawHref, sourceUrl);
    try {
      const u = new URL(href);
      if (origin && u.origin !== origin) continue;
      if (isSkippableListingPath(u.pathname)) continue;
      if (u.pathname === "/" || u.pathname === "" || u.href === sourceUrl) continue;
    } catch {
      continue;
    }

    const title = decodeEntities(rawTitle);
    if (!title || title.length < 8 || title.length > 220) continue;
    if (/^(image|img|logo|icon|photo)$/i.test(title)) continue;
    if (seen.has(href)) continue;
    seen.add(href);

    items.push({ title, link: href, description: title, pubDate: undefined });
    if (items.length >= 30) break;
  }

  return items;
}

function extractArticleAsItem(html: string, sourceUrl: string): FeedItem {
  const title =
    extractMeta(html, "og:title") ||
    extractMeta(html, "twitter:title") ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ||
    sourceUrl;
  const description =
    extractMeta(html, "og:description") ||
    extractMeta(html, "description") ||
    extractMeta(html, "twitter:description") ||
    title;
  const pubRaw =
    extractMeta(html, "article:published_time") ||
    extractMeta(html, "og:published_time") ||
    extractMeta(html, "date") ||
    extractMeta(html, "pubdate");
  const pubDate = pubRaw ? new Date(pubRaw).toUTCString() : new Date().toUTCString();
  return {
    title: stripTags(title),
    link: sourceUrl,
    description: stripTags(description),
    pubDate: pubDate !== "Invalid Date" ? pubDate : undefined,
  };
}

export async function extractFeed(sourceUrl: string): Promise<ExtractedFeed> {
  const html = await fetchWithBypass(sourceUrl);

  // 1. Real RSS/Atom XML feed
  const xmlFeed = tryParseXmlFeed(html, sourceUrl);
  if (xmlFeed) return xmlFeed;

  // 2. HTML page — auto-discover a linked RSS/Atom feed and follow it
  const discovered = discoverFeedLink(html, sourceUrl);
  if (discovered && discovered !== sourceUrl) {
    try {
      const feedXml = await fetchWithBypass(discovered);
      const parsed = tryParseXmlFeed(feedXml, discovered);
      if (parsed) return parsed;
    } catch {
      // fall through to scraping
    }
  }

  const siteTitle =
    extractMeta(html, "og:site_name") ||
    extractMeta(html, "og:title") ||
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? sourceUrl);

  const siteDesc =
    extractMeta(html, "og:description") ||
    extractMeta(html, "description") ||
    `Auto-generated RSS feed for ${sourceUrl}`;

  // 3. Scrape article links from a listing/index page. Prefer titles that
  // are wrapped in heading tags (the pattern real blog listings use) since
  // it's far more precise than treating every link on the page as an item;
  // only fall back to a flat link scan if the page doesn't use headings for
  // its post titles at all.
  const headingItems = extractHeadingLinkedItems(html, sourceUrl);
  let items = headingItems.length >= 3 ? headingItems : extractAnyLinkedItems(html, sourceUrl);

  // If that came up (almost) empty, the page is likely client-rendered and
  // the static HTML we fetched never had the article list in it to begin
  // with. Retry through a proxy that executes the page's JS first.
  if (items.length < 2) {
    const rendered = await fetchRenderedViaReader(sourceUrl);
    if (rendered) {
      const renderedItems = extractMarkdownLinkedItems(rendered, sourceUrl);
      if (renderedItems.length > items.length) items = renderedItems;
    }
  }

  // 4. Newsletter / single-article fallback — treat the page itself as one item
  if (items.length === 0) {
    items.push(extractArticleAsItem(html, sourceUrl));
  }

  return {
    title: stripTags(siteTitle),
    description: stripTags(siteDesc),
    link: sourceUrl,
    items: sortNewestFirst(items),
    isRealFeed: false,
  };
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function feedToRss(feed: ExtractedFeed): string {
  const items = feed.items
    .map(
      (i) => `    <item>
      <title>${xmlEscape(i.title)}</title>
      <link>${xmlEscape(i.link)}</link>
      <guid isPermaLink="true">${xmlEscape(i.link)}</guid>
      <description>${xmlEscape(i.description)}</description>
      ${i.pubDate ? `<pubDate>${xmlEscape(i.pubDate)}</pubDate>` : ""}
    </item>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlEscape(feed.title)}</title>
    <link>${xmlEscape(feed.link)}</link>
    <description>${xmlEscape(feed.description)}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;
}
