#!/bin/sh
# Start the bundled connector with the first Node.js 20+ found. GUI hosts often
# spawn MCP servers with a minimal PATH, so common install locations are
# checked as well. ICLOUD_MAIL_NODE selects an exact binary.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for node in "$ICLOUD_MAIL_NODE" "$(command -v node 2>/dev/null)" \
  /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" /usr/bin/node \
  "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -n "$node" ] && [ -x "$node" ] || continue
  major=$("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || continue
  [ "$major" -ge 20 ] 2>/dev/null || continue
  exec "$node" "$here/server.cjs" "$@"
done
echo "icloud-mail: Node.js 20+ not found. Install Node.js or set ICLOUD_MAIL_NODE." >&2
exit 127
