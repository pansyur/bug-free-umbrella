import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { extractFeed, filterByPathPrefix, derivePathPrefix } from "@/lib/feed-extractor";

async function refreshFeedRow(
  supabase: any,
  feed: { id: string; url: string; user_id: string; item_path_prefix?: string | null },
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
      // onConflict + ignoreDuplicates means: if a row for this (feed_id, link)
      // already exists — including one the user soft-deleted — it is left
      // alone rather than recreated, so deleted items never come back as new.
      await supabase
        .from("feed_items")
        .upsert(rows, { onConflict: "feed_id,link", ignoreDuplicates: true });
    }
    return { ok: true, count: keptItems.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase
      .from("feeds")
      .update({ last_error: msg, last_refreshed_at: new Date().toISOString() })
      .eq("id", feed.id);
    return { ok: false, error: msg };
  }
}

// Step 1 of adding a feed: fetch + parse the URL and tell the caller whether
// it's a real RSS/Atom feed or a scraped HTML page, so the UI can decide
// whether to ask the user to curate items before saving.
export const previewFeedSetup = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ url: z.string().url() }).parse(input))
  .handler(async ({ data }) => {
    const extracted = await extractFeed(data.url);
    return extracted;
  });

export const addFeed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        url: z.string().url(),
        // Links the user confirmed as "real" items when the source wasn't a
        // genuine RSS/Atom feed. If omitted, all scraped items are kept.
        selectedLinks: z.array(z.string()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const extracted = await extractFeed(data.url);

    let items = extracted.items;
    let itemPathPrefix: string | null = null;
    if (!extracted.isRealFeed && data.selectedLinks && data.selectedLinks.length) {
      const keep = new Set(data.selectedLinks);
      items = extracted.items.filter((it) => keep.has(it.link));
      itemPathPrefix = derivePathPrefix([...keep]) ?? null;
    }

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
          item_path_prefix: itemPathPrefix,
        },
        { onConflict: "user_id,url" },
      )
      .select()
      .single();
    if (error) throw new Error(error.message);

    if (items.length) {
      const rows = items.map((it) => ({
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

// Add many feeds at once (one URL per line pasted by the user). Each URL is
// processed independently and sequentially — sequentially so we don't hammer
// several different sites with concurrent requests, and independently so one
// bad URL doesn't fail the whole batch. Scraped (non-RSS) sources keep every
// link found, same as addFeed does when no selectedLinks are given, since
// there's no per-link curation step in a bulk flow.
export const bulkAddFeeds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        urls: z.array(z.string().url()).min(1).max(50),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const results: {
      url: string;
      ok: boolean;
      title?: string;
      itemCount?: number;
      isRealFeed?: boolean;
      error?: string;
    }[] = [];

    // De-dupe input while preserving order, so pasting the same URL twice
    // doesn't try to add it twice.
    const urls = [...new Set(data.urls.map((u) => u.trim()).filter(Boolean))];

    for (const url of urls) {
      try {
        const extracted = await extractFeed(url);
        const { data: feed, error } = await supabase
          .from("feeds")
          .upsert(
            {
              user_id: userId,
              url,
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

        results.push({
          url,
          ok: true,
          title: extracted.title,
          itemCount: extracted.items.length,
          isRealFeed: extracted.isRealFeed,
        });
      } catch (e) {
        results.push({ url, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return { results };
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
      .eq("user_id", userId)
      .eq("is_deleted", false);

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
        search: z.string().max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    let q = supabase
      .from("feed_items")
      .select("id,feed_id,link,title,description,pub_date,is_read,created_at,feeds(title)")
      .eq("user_id", userId)
      .eq("is_deleted", false)
      // Newest item first: sort by the article's own publish date, falling
      // back to when we fetched it for items without one.
      .order("pub_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 200);
    if (data.feedId) q = q.eq("feed_id", data.feedId);
    if (data.unreadOnly) q = q.eq("is_read", false);
    const term = data.search?.trim();
    if (term) {
      // Escape ilike wildcards so a literal "%" or "_" in a search doesn't
      // behave like a wildcard.
      const escaped = term.replace(/[%_]/g, (c) => `\\${c}`);
      q = q.ilike("title", `%${escaped}%`);
    }
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
      .eq("is_read", false)
      .eq("is_deleted", false);
    if (data.feedId) q = q.eq("feed_id", data.feedId);
    const { error } = await q;
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Soft-delete: rows are kept (is_deleted = true) so the (feed_id, link)
// UNIQUE constraint still prevents the same article being re-inserted as
// "new" the next time the feed is refreshed/scraped.
export const deleteItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ ids: z.array(z.string().uuid()) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    if (!data.ids.length) return { deleted: 0 };
    const { error, count } = await supabase
      .from("feed_items")
      .update({ is_deleted: true }, { count: "exact" })
      .eq("user_id", userId)
      .in("id", data.ids);
    if (error) throw new Error(error.message);
    return { deleted: count ?? 0 };
  });

// Bulk "clean up" action: soft-deletes every already-read item (optionally
// scoped to one feed) so it disappears from lists and never reappears.
export const deleteReadItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ feedId: z.string().uuid().nullable().optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    let q = supabase
      .from("feed_items")
      .update({ is_deleted: true }, { count: "exact" })
      .eq("user_id", userId)
      .eq("is_read", true)
      .eq("is_deleted", false);
    if (data.feedId) q = q.eq("feed_id", data.feedId);
    const { error, count } = await q;
    if (error) throw new Error(error.message);
    return { deleted: count ?? 0 };
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
      .select("id,url,user_id,item_path_prefix")
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
      .select("id,url,user_id,item_path_prefix")
      .eq("user_id", userId);
    const results = await Promise.all(
      (feeds ?? []).map((f) => refreshFeedRow(supabase, f)),
    );
    return { refreshed: results.length };
  });
