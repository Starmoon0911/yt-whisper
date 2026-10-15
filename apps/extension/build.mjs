import { build } from "esbuild";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const destination = path.join(root, "dist");
const exists = async name => access(path.join(root, name)).then(() => true, () => false);
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const entryPoints = { background: path.join(root, "src/background.ts"), popup: path.join(root, "src/popup.ts") };
// Task 5 hook: content.ts (+ optional content.css) is picked up automatically.
// Until then no missing content.js is referenced, so this dist is loadable.
if (await exists("src/content.ts")) {
  entryPoints.content = path.join(root, "src/content.ts");
  manifest.content_scripts = [{
    matches: ["https://www.youtube.com/*", "https://youtube.com/*", "https://m.youtube.com/*"],
    js: ["content.js"], run_at: "document_idle",
    ...(await exists("src/content.css") ? { css: ["content.css"] } : {}),
  }];
}
await mkdir(destination, { recursive: true });
await build({ entryPoints, outdir: destination, bundle: true, format: "iife", target: "chrome120", logLevel: "info" });
for (const name of ["popup.html", "popup.css", ...(manifest.content_scripts?.[0]?.css ?? [])]) {
  await copyFile(path.join(root, "src", name), path.join(destination, name));
}
await writeFile(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
