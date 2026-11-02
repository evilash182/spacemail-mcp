#!/usr/bin/env node
// Stands in for the `claude` CLI during setup tests: records `mcp add/remove` into the
// config file the wizard reads (SPACEMAIL_SETUP_CLAUDE_CONFIG), like Claude Code does.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = process.env.SPACEMAIL_SETUP_CLAUDE_CONFIG;
const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { mcpServers: {} };
const [, , group, action, name, ...rest] = process.argv;

if (group !== "mcp") process.exit(2);
if (action === "remove") {
  if (!config.mcpServers[name]) process.exit(1);
  delete config.mcpServers[name];
} else if (action === "add") {
  const split = rest.indexOf("--");
  const options = rest.slice(0, split);
  const [command, ...args] = rest.slice(split + 1);
  const env = {};
  for (let i = 0; i < options.length; i++) {
    if (options[i] === "-e") {
      const [key, ...value] = options[++i].split("=");
      env[key] = value.join("=");
    }
  }
  config.mcpServers[name] = { type: "stdio", command, args, env, scope: options[options.indexOf("-s") + 1] };
}
writeFileSync(file, JSON.stringify(config, null, 2));
