
CREATE TABLE public.feeds (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  last_refreshed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, url)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feeds TO authenticated;
GRANT ALL ON public.feeds TO service_role;
ALTER TABLE public.feeds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own feeds" ON public.feeds FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX feeds_user_idx ON public.feeds(user_id, created_at DESC);

CREATE TABLE public.feed_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  feed_id UUID NOT NULL REFERENCES public.feeds(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  link TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  pub_date TIMESTAMPTZ,
  is_read BOOLEAN NOT NULL DEFAULT false,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (feed_id, link)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feed_items TO authenticated;
GRANT ALL ON public.feed_items TO service_role;
ALTER TABLE public.feed_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own items" ON public.feed_items FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX feed_items_user_created_idx ON public.feed_items(user_id, created_at DESC);
CREATE INDEX feed_items_feed_created_idx ON public.feed_items(feed_id, created_at DESC);
CREATE INDEX feed_items_user_unread_idx ON public.feed_items(user_id, is_read, created_at DESC);

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
