import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { extractFeed } from "./feed-extractor";

export const previewFeed = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ url: z.string().url() }).parse(input))
  .handler(async ({ data }) => {
    const feed = await extractFeed(data.url);
    return feed;
  });
