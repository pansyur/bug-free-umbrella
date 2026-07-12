// Standalone Vite config (previously wrapped by @lovable.dev/vite-tanstack-config,
// which has been removed). This wires up the same plugins by hand and targets
// Cloudflare Pages via Nitro's Cloudflare preset.
//
// NOTE: this was written without being able to `bun install` / build in the
// authoring environment (no network access), so double-check it against
// TanStack Start's current Cloudflare Pages deployment docs after installing
// dependencies — in particular the exact `tanstackStart({ server: {...} })`
// option names (`preset`, `entry`) may need small adjustments for the pinned
// `nitro` version in package.json.
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart({
  server: {
    entry: "server",
    preset: "cloudflare_pages",   // was "cloudflare_module"
  },
}),
    }),
    viteReact(),
  ],
});
