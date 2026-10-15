#!/bin/sh
# Links the MCP Bridge add-on into Blender's user extensions and enables it.
# Run with Blender CLOSED: a running Blender would overwrite the saved preferences on quit.
set -e
BLENDER_BIN="${BLENDER_MCP_BIN:-/Applications/Blender.app/Contents/MacOS/Blender}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$("$BLENDER_BIN" --version | head -1 | sed -E 's/Blender ([0-9]+\.[0-9]+).*/\1/')"
DEST="$HOME/Library/Application Support/Blender/$VERSION/extensions/user_default"

if pgrep -x Blender >/dev/null; then
  echo "Blender is running. Close it first, then run this again." >&2
  exit 1
fi

mkdir -p "$DEST"
ln -sfn "$REPO/addon/blender_mcp_bridge" "$DEST/blender_mcp_bridge"
"$BLENDER_BIN" -b --python-expr "
import bpy
bpy.ops.preferences.addon_enable(module='bl_ext.user_default.blender_mcp_bridge')
bpy.ops.wm.save_userpref()
print('MCP Bridge enabled')
" 2>&1 | grep -E 'MCP Bridge|Error|error' || true
echo "Linked $DEST/blender_mcp_bridge -> $REPO/addon/blender_mcp_bridge (Blender $VERSION)"
