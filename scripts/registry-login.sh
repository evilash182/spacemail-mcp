#!/bin/sh
# Logs mcp-publisher in to the MCP Registry as norwichwebsite.design, using the signing key
# whose public half is served at https://norwichwebsite.design/.well-known/mcp-registry-auth.
set -eu

KEY="${MCP_REGISTRY_KEY:-$HOME/.config/nwd/mcp-registry-key.pem}"
OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl
[ -x "$OPENSSL" ] || OPENSSL=openssl

PRIVATE_KEY="$("$OPENSSL" pkey -in "$KEY" -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
mcp-publisher login http --domain norwichwebsite.design --private-key "$PRIVATE_KEY"
