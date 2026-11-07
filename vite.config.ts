import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/** The headers public/_headers gives every path ("/*"), so `vite preview` serves what Netlify will. */
function siteHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  let inSiteBlock = false;
  for (const line of readFileSync(new URL("public/_headers", import.meta.url), "utf8").split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      inSiteBlock = line.trim() === "/*";
      continue;
    }
    const colon = line.indexOf(":");
    if (inSiteBlock && colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return headers;
}

export default defineConfig({
  base: "./",
  // PGlite loads its own .wasm and .data files; pre-bundling would break those URLs.
  optimizeDeps: { exclude: ["@electric-sql/pglite"] },
  worker: { format: "es" },
  build: {
    target: "es2022",
    rolldownOptions: {
      // PGlite's Emscripten glue uses eval by design; that warning is about the dependency, not this code.
      onLog(level, log, handler) {
        if (log.code === "EVAL" && log.id?.includes("@electric-sql/pglite")) return;
        handler(level, log);
      },
    },
  },
  preview: { headers: siteHeaders() },
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
