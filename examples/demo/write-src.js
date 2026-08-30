'use strict';
// Write the demo "coinwatch" source tree with a deliberate spread of Cell states.
const fs = require('fs'), path = require('path');
const root = process.argv[2];
const B = (id) => `//∷YAY⟨${id}⟩`;
const E = (id) => `//∷YAY-END⟨${id}⟩`;
function w(rel, body) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}

// C-1 · GREEN — pure, strong checkable ensures.
w('src/holdings.js', `${B('C-1')}
// unit: addHolding
// intent: Add a coin amount to a running total, never going below zero.
// in: total: number, amount: number
// out: number
// ensures: returns total + amount; if the sum is negative it returns 0
// pure: yes
${E('C-1')}
function addHolding(total, amount) {
  const sum = total + amount;
  return sum < 0 ? 0 : sum;
}
module.exports = { addHolding };
`);

// C-2 · YELLOW — signed but prose-only (no ensures) → honest cap at Yellow.
w('src/format.js', `${B('C-2')}
// unit: formatMoney
// intent: Format a number as a USD price string for the dashboard.
// pure: yes
${E('C-2')}
function formatMoney(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
module.exports = { formatMoney };
`);

// C-3 · RED — declares pure: yes but the body performs network I/O.
w('src/sync.js', `${B('C-3')}
// unit: syncPrices
// intent: Return the latest prices for a list of coin symbols.
// in: symbols: string[]
// out: Promise<object>
// pure: yes
${E('C-3')}
async function syncPrices(symbols) {
  const res = await fetch('https://api.example.com/prices?ids=' + symbols.join(','));
  return res.json();
}
module.exports = { syncPrices };
`);

// C-4 · YELLOW, tagged security — the required-signer / policy showcase.
w('src/auth.js', `${B('C-4')}
// unit: checkAccess
// intent: Decide whether a session may view a given portfolio.
// in: session: object, portfolioId: string
// out: boolean
// tags: security
// sensitive: yes
${E('C-4')}
function checkAccess(session, portfolioId) {
  if (!session || !session.userId) return false;
  return session.portfolios.includes(portfolioId);
}
module.exports = { checkAccess };
`);

// C-5 · UNSIGNED — a well-formed Cell we never sign.
w('src/report.js', `${B('C-5')}
// unit: exportReport
// intent: Build a plain-text portfolio summary for export.
// in: holdings: object[]
// out: string
// ensures: one line per holding in input order
// pure: yes
${E('C-5')}
function exportReport(holdings) {
  return holdings.map((h) => h.symbol + ': ' + h.amount).join('\\n');
}
module.exports = { exportReport };
`);

// PINK — a real function with no Cell governing it at all.
w('src/legacy.js', `// TODO: never got specced — the coverage net catches it.
function roundLots(n) {
  return Math.round(n * 100) / 100;
}
module.exports = { roundLots };
`);

console.log('wrote demo src to', root);
