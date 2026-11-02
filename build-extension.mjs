// Builds the one-click Claude Desktop extension (.mcpb) from the bundled server.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

// The MCP Registry entry points at this exact file, so record its version and hash there.
const server = JSON.parse(readFileSync("server.json", "utf8"));
const bundle = server.packages.find((p) => p.registryType === "mcpb");
server.version = pkg.version;
for (const p of server.packages) p.version = pkg.version;
bundle.identifier = `https://github.com/evilash182/spacemail-mcp/releases/download/v${pkg.version}/spacemail.mcpb`;
bundle.fileSha256 = createHash("sha256").update(readFileSync(out)).digest("hex");
writeFileSync("server.json", `${JSON.stringify(server, null, 2)}\n`);

// The Claude plugin runs the npm package pinned to this exact version, as the plugin directory requires.
const plugin = JSON.parse(readFileSync("plugin/.claude-plugin/plugin.json", "utf8"));
plugin.version = pkg.version;
writeFileSync("plugin/.claude-plugin/plugin.json", `${JSON.stringify(plugin, null, 2)}\n`);
const mcp = JSON.parse(readFileSync("plugin/.mcp.json", "utf8"));
mcp.mcpServers.spacemail.args = ["-y", `spacemail-mcp@${pkg.version}`];
writeFileSync("plugin/.mcp.json", `${JSON.stringify(mcp, null, 2)}\n`);
console.log(`\nExtension ready: ${out}`);
