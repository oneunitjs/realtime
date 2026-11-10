import { defineConfig, PluginOption } from "vitest/config";
import path from "node:path";
import fs from "node:fs";

/**
 * Vite plugin: resolve relative `.js` imports to `.ts` source files.
 *
 * Source and test files import from `../../../src/.../index.js` but the
 * source is `.ts`. Vite does not auto-substitute `.js`→`.ts` for imports that
 * already carry an extension, so we intercept relative `.js` specifiers and
 * redirect them to the `.ts` counterpart when it exists. Absolute/bare
 * specifiers (node_modules) are left untouched.
 */
const resolveJsToTsPlugin: PluginOption = {
  name: "resolve-js-relative-to-ts",
  enforce: "pre",
  resolveId(source, importer, options) {
    if (typeof source !== "string" || !source.endsWith(".js")) return null;
    // Only handle relative imports; bare specifiers go to node_modules.
    if (!source.startsWith(".") || !importer) return null;

    const tsSource = source.replace(/\.js$/, ".ts");
    const resolved = path.resolve(path.dirname(importer), tsSource);
    try {
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // ignore filesystem errors; fall through to default resolution
    }
    return null;
  },
};

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
  plugins: [resolveJsToTsPlugin],
});
