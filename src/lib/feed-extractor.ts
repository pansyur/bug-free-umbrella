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

async function fetchWithBypass(url: string): Promise<string> {
  // Try direct fetch first with browser-like headers
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
    if (res.ok) return await res.text();
    if (res.status !== 403 && res.status !== 503 && res.status !== 429) {
      throw new Error(`Upstream returned ${res.status}`);
    }
  } catch {
    // fall through
  }

  // Fallback: use a public read-only proxy that renders JS and bypasses CF
  const proxied = `https://r.jina.ai/${url}`;
  const res = await fetch(proxied, {
    headers: { "User-Agent": BROWSER_HEADERS["User-Agent"], Accept: "text/html,*/*" },
  });
  if (!res.ok) throw new Error(`Failed to fetch page (${res.status})`);
  return await res.text();
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

  // 3. Try to scrape article links from a listing/index page
  const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  const items: FeedItem[] = [];

  const origin = (() => {
    try {
      return new URL(sourceUrl).origin;
    } catch {
      return "";
    }
  })();

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
      if (/\/(tag|category|author|page|search|login|signup|about|contact|privacy|terms)(\/|$)/i.test(u.pathname)) continue;
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

    items.push({
      title,
      link: href,
      description: title,
      pubDate: new Date().toUTCString(),
    });

    if (items.length >= 30) break;
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
