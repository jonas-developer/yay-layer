'use strict';
// The two Cells produced under the Autopilot grant (C-6 delegated/awaiting, C-7 rejected).
const fs = require('fs'), path = require('path');
const root = process.argv[2];
const B = (id) => `//∷YAY⟨${id}⟩`;
const E = (id) => `//∷YAY-END⟨${id}⟩`;
function w(rel, body) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}

w('src/ui/sparkline.js', `${B('C-6')}
// unit: sparkPoints
// intent: Map a price series to sparkline y-coordinates in a fixed height.
// in: prices: number[], height: number
// out: number[]
// ensures: every output is between 0 and height inclusive
// pure: yes
${E('C-6')}
function sparkPoints(prices, height) {
  const lo = Math.min(...prices), hi = Math.max(...prices), span = (hi - lo) || 1;
  return prices.map((p) => Math.round(((p - lo) / span) * height));
}
module.exports = { sparkPoints };
`);

w('src/ui/badge.js', `${B('C-7')}
// unit: trendBadge
// intent: Choose an up/down badge label for a percent change.
// in: pct: number
// out: string
// ensures: returns "up" for positive, "down" for negative, "flat" for zero
// pure: yes
${E('C-7')}
function trendBadge(pct) {
  return pct > 0 ? "up" : pct < 0 ? "down" : "flat";
}
module.exports = { trendBadge };
`);

console.log('wrote delegated src');
