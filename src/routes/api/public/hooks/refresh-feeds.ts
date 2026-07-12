import { createFileRoute } from "@tanstack/react-router";
import { extractFeed, filterByPathPrefix } from "@/lib/feed-extractor";

export const Route = createFileRoute("/api/public/hooks/refresh-feeds")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!apikey || apikey !== expected) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );

        const { data: feeds, error } = await supabaseAdmin
          .from("feeds")
          .select("id,url,user_id,item_path_prefix");
        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        let ok = 0;
        let failed = 0;
        for (const feed of feeds ?? []) {
          try {
            const extracted = await extractFeed(feed.url);
            await supabaseAdmin
              .from("feeds")
              .update({
                title: extracted.title,
                description: extracted.description,
                last_refreshed_at: new Date().toISOString(),
                last_error: null,
              })
              .eq("id", feed.id);
            const keptItems = extracted.isRealFeed
              ? extracted.items
              : filterByPathPrefix(extracted.items, feed.item_path_prefix);
            if (keptItems.length) {
              const rows = keptItems.map((it) => ({
                feed_id: feed.id,
                user_id: feed.user_id,
                link: it.link,
                title: it.title.slice(0, 500),
                description: (it.description ?? "").slice(0, 2000),
                pub_date: it.pubDate ? new Date(it.pubDate).toISOString() : null,
              }));
              await supabaseAdmin
                .from("feed_items")
                .upsert(rows, { onConflict: "feed_id,link", ignoreDuplicates: true });
            }
            ok += 1;
          } catch (e) {
            failed += 1;
            await supabaseAdmin
              .from("feeds")
              .update({
                last_error: e instanceof Error ? e.message : String(e),
                last_refreshed_at: new Date().toISOString(),
              })
              .eq("id", feed.id);
          }
        }

        return new Response(
          JSON.stringify({ ok, failed, total: feeds?.length ?? 0 }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
