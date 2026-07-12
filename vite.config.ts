import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart({
      server: {
        // Redirect TanStack Start's bundled server entry to src/server.ts
        // (our SSR error wrapper).
        entry: "server",
      },
    }),
    nitro({
      // Nitro preset for Cloudflare Pages output (matches
      // pages_build_output_dir = "dist" in wrangler.toml).
      preset: "cloudflare_pages",
    }),
    viteReact(),
  ],
});
