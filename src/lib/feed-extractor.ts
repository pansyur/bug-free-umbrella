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
    items,
  };
}

export async function extractFeed(sourceUrl: string): Promise<ExtractedFeed> {
  const html = await fetchWithBypass(sourceUrl);

  // Prefer a real RSS/Atom parse when the source actually is a feed —
  // this is what makes item titles correct (true <title> per item)
  // instead of the best-effort link-text guess used for plain web pages.
  const xmlFeed = tryParseXmlFeed(html, sourceUrl);
  if (xmlFeed) return xmlFeed;

  const siteTitle =
    extractMeta(html, "og:site_name") ||
    extractMeta(html, "og:title") ||
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? sourceUrl);

  const siteDesc =
    extractMeta(html, "og:description") ||
    extractMeta(html, "description") ||
    `Auto-generated RSS feed for ${sourceUrl}`;

  // Find candidate links: <a href="..."> with visible text
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
    // Only same-origin or same-host children
    try {
      const u = new URL(href);
      if (origin && u.origin !== origin) continue;
      // Skip common non-article paths
      if (/\/(tag|category|author|page|search|login|signup|about|contact|privacy|terms)(\/|$)/i.test(u.pathname)) continue;
      // Skip root-only
      if (u.pathname === "/" || u.pathname === "") continue;
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

  return {
    title: stripTags(siteTitle),
    description: stripTags(siteDesc),
    link: sourceUrl,
    items,
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
