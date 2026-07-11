import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { extractFeed } from "@/lib/feed-extractor";

async function refreshFeedRow(
  supabase: any,
  feed: { id: string; url: string; user_id: string },
) {
  try {
    const extracted = await extractFeed(feed.url);
    await supabase
      .from("feeds")
      .update({
        title: extracted.title,
        description: extracted.description,
        last_refreshed_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", feed.id);

    if (extracted.items.length) {
      const rows = extracted.items.map((it) => ({
        feed_id: feed.id,
        user_id: feed.user_id,
        link: it.link,
        title: it.title.slice(0, 500),
        description: (it.description ?? "").slice(0, 2000),
        pub_date: it.pubDate ? new Date(it.pubDate).toISOString() : null,
      }));
      await supabase
        .from("feed_items")
        .upsert(rows, { onConflict: "feed_id,link", ignoreDuplicates: true });
    }
    return { ok: true, count: extracted.items.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase
      .from("feeds")
      .update({ last_error: msg, last_refreshed_at: new Date().toISOString() })
      .eq("id", feed.id);
    return { ok: false, error: msg };
  }
}

export const addFeed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ url: z.string().url() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const extracted = await extractFeed(data.url);
    const { data: feed, error } = await supabase
      .from("feeds")
      .upsert(
        {
          user_id: userId,
          url: data.url,
          title: extracted.title,
          description: extracted.description,
          last_refreshed_at: new Date().toISOString(),
          last_error: null,
        },
        { onConflict: "user_id,url" },
      )
      .select()
      .single();
    if (error) throw new Error(error.message);

    if (extracted.items.length) {
      const rows = extracted.items.map((it) => ({
        feed_id: feed.id,
        user_id: userId,
        link: it.link,
        title: it.title.slice(0, 500),
        description: (it.description ?? "").slice(0, 2000),
        pub_date: it.pubDate ? new Date(it.pubDate).toISOString() : null,
      }));
      await supabase
        .from("feed_items")
        .upsert(rows, { onConflict: "feed_id,link", ignoreDuplicates: true });
    }
    return feed;
  });

export const listFeeds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: feeds, error } = await supabase
      .from("feeds")
      .select("id,url,title,description,last_refreshed_at,last_error,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const { data: counts } = await supabase
      .from("feed_items")
      .select("feed_id,is_read")
      .eq("user_id", userId);

    const unread = new Map<string, number>();
    const total = new Map<string, number>();
    for (const r of counts ?? []) {
      total.set(r.feed_id, (total.get(r.feed_id) ?? 0) + 1);
      if (!r.is_read) unread.set(r.feed_id, (unread.get(r.feed_id) ?? 0) + 1);
    }
    return (feeds ?? []).map((f) => ({
      ...f,
      unread_count: unread.get(f.id) ?? 0,
      total_count: total.get(f.id) ?? 0,
    }));
  });

export const listItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        feedId: z.string().uuid().nullable().optional(),
        unreadOnly: z.boolean().optional(),
        limit: z.number().min(1).max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    let q = supabase
      .from("feed_items")
      .select("id,feed_id,link,title,description,pub_date,is_read,created_at,feeds(title)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 200);
    if (data.feedId) q = q.eq("feed_id", data.feedId);
    if (data.unreadOnly) q = q.eq("is_read", false);
    const { data: items, error } = await q;
    if (error) throw new Error(error.message);
    return items ?? [];
  });

export const markItemsRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ ids: z.array(z.string().uuid()), read: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    if (!data.ids.length) return { updated: 0 };
    const { error, count } = await supabase
      .from("feed_items")
      .update({ is_read: data.read }, { count: "exact" })
      .eq("user_id", userId)
      .in("id", data.ids);
    if (error) throw new Error(error.message);
    return { updated: count ?? 0 };
  });

export const markAllRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ feedId: z.string().uuid().nullable().optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    let q = supabase
      .from("feed_items")
      .update({ is_read: true })
      .eq("user_id", userId)
      .eq("is_read", false);
    if (data.feedId) q = q.eq("feed_id", data.feedId);
    const { error } = await q;
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteFeed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("feeds")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const refreshFeed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: feed, error } = await supabase
      .from("feeds")
      .select("id,url,user_id")
      .eq("id", data.id)
      .eq("user_id", userId)
      .single();
    if (error || !feed) throw new Error("Feed not found");
    return refreshFeedRow(supabase, feed);
  });

export const refreshAllFeeds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: feeds } = await supabase
      .from("feeds")
      .select("id,url,user_id")
      .eq("user_id", userId);
    const results = await Promise.all(
      (feeds ?? []).map((f) => refreshFeedRow(supabase, f)),
    );
    return { refreshed: results.length };
  });
