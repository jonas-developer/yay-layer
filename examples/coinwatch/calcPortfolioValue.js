//∷YAY⟨C-040⟩ v1
//  unit:    calcPortfolioValue
//  lang:    js
//  intent:  Sum each holding's quantity times its current price into one USD total.
//  in:      holdings: Array<{qty:number, priceUsd:number}>
//  out:     totalUsd: number
//  pure:    yes
//  ensures: totalUsd == sum(h.qty * h.priceUsd);  holdings==[] => 0
//  feeds:   C-041
//∷YAY-END⟨C-040⟩
function calcPortfolioValue(holdings) {
  return holdings.reduce((t, h) => t + h.qty * h.priceUsd, 0);
}

module.exports = { calcPortfolioValue };
