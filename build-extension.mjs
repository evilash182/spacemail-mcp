// Builds the one-click Claude Desktop extension (.mcpb) from the bundled server.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const stage = "build/extension";

rmSync(stage, { recursive: true, force: true });
mkdirSync(`${stage}/server`, { recursive: true });

const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
manifest.version = pkg.version;
writeFileSync(`${stage}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
cpSync("dist/index.cjs", `${stage}/server/index.cjs`);
cpSync("assets/icon.png", `${stage}/icon.png`);
cpSync("LICENSE", `${stage}/LICENSE`);

const out = `build/spacemail-${pkg.version}.mcpb`;
execFileSync("npx", ["mcpb", "validate", `${stage}/manifest.json`], { stdio: "inherit" });
execFileSync("npx", ["mcpb", "pack", stage, out], { stdio: "inherit" });
console.log(`\nExtension ready: ${out}`);
