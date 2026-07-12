-- Soft-delete for feed items: keeping the row (instead of a hard DELETE) means
-- the (feed_id, link) UNIQUE constraint still blocks the same article from
-- being re-inserted as "new" on the next scrape/refresh.
ALTER TABLE public.feed_items
  ADD COLUMN is_deleted BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX feed_items_user_visible_idx
  ON public.feed_items (user_id, is_deleted, is_read, created_at DESC);

-- Remembers which URL "shape" the user picked when setting up a scraped
-- (non-RSS) feed, e.g. "/blog/" — future refreshes only keep items whose
-- link starts with this prefix, filtering out nav/category noise.
ALTER TABLE public.feeds
  ADD COLUMN item_path_prefix TEXT;
