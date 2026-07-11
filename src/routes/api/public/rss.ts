import { createFileRoute } from "@tanstack/react-router";
import { extractFeed, feedToRss } from "@/lib/feed-extractor";

export const Route = createFileRoute("/api/public/rss")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const target = url.searchParams.get("url");
        if (!target) {
          return new Response("Missing ?url= parameter", { status: 400 });
        }
        try {
          // eslint-disable-next-line no-new
          new URL(target);
        } catch {
          return new Response("Invalid url", { status: 400 });
        }
        try {
          const feed = await extractFeed(target);
          const xml = feedToRss(feed);
          return new Response(xml, {
            headers: {
              "Content-Type": "application/rss+xml; charset=utf-8",
              "Cache-Control": "public, max-age=600",
              "Access-Control-Allow-Origin": "*",
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          return new Response(`Failed to generate feed: ${msg}`, { status: 502 });
        }
      },
    },
  },
});
