#!/usr/bin/env sh
set -e

FONT_SRC="/opt/inspect-fonts"
FONT_DST="/app/data/fonts"

if [ -d "$FONT_SRC" ]; then
  mkdir -p "$FONT_DST"
  for font in "$FONT_SRC"/*.ttf "$FONT_SRC"/*.ttc; do
    [ -f "$font" ] || continue
    base=$(basename "$font")
    if [ ! -f "$FONT_DST/$base" ]; then
      cp "$font" "$FONT_DST/$base"
    fi
  done
fi

exec "$@"
