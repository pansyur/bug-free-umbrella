import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { extractFeed } from "./feed-extractor";

// Used by the public landing page's live "try it out" preview (no auth,
// nothing persisted). The authenticated reader's "Add feed" flow uses
// `previewFeedSetup` / `addFeed` in reader.functions.ts instead, which also
// exposes `isRealFeed` so the UI can offer item curation for scraped pages.
export const previewFeed = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ url: z.string().url() }).parse(input))
  .handler(async ({ data }) => {
    const feed = await extractFeed(data.url);
    return feed;
  });
