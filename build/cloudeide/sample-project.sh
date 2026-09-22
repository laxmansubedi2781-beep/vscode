#!/usr/bin/env bash
#
# Writes the project the application is photographed and filmed with.
#
# Both the smoke test and the recording open a folder, and they have to open
# the same one: the two pictures sit on the same page, and a tree that changes
# between them reads as two different products. It is small enough to take in
# at a glance on a landing page and real enough to deploy — index.html is what
# the Deploy clip puts on a URL.
#
# `.env` and `node_modules` are here on purpose. Neither is ever uploaded —
# cloudeideWorkspace.ts skips both — and a tree without them does not look
# like anyone's actual project.
#
# Usage: sample-project.sh [directory]   (default /tmp/ws)
set -euo pipefail

ws="${1:-/tmp/ws}"
rm -rf "$ws"
mkdir -p "$ws/src" "$ws/node_modules/.keep-dir"

cat > "$ws/src/menu.js" <<'JS'
export const menu = [
  { name: 'Espresso',    price: 120 },
  { name: 'Masala Chai', price: 60 },
  { name: 'Cold Brew',   price: 150 },
];

export function total(items) {
  return items.reduce((sum, i) => sum + i.price, 0);
}

export function format(item) {
  return `${item.name}`;
}
JS

cat > "$ws/index.html" <<'HTML'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cafe Nirvana</title>
  </head>
  <body>
    <h1>Cafe Nirvana</h1>
    <ul id="menu"></ul>
    <script type="module" src="./src/menu.js"></script>
  </body>
</html>
HTML

cat > "$ws/README.md" <<'MD'
# Cafe Nirvana

The menu for a small coffee shop, and the page it is served on.
MD

printf 'ANALYTICS_KEY=not-a-real-key\n' > "$ws/.env"
printf '{}\n' > "$ws/node_modules/.keep-dir/package.json"

find "$ws" -type f | sort
