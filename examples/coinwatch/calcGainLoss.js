//∷YAY⟨C-041⟩ v1
//  unit:    calcGainLoss
//  lang:    js
//  intent:  Return absolute and percentage gain versus cost basis.
//  in:      totalUsd:number, costBasisUsd:number
//  out:     { absUsd:number, pct:number }
//  pure:    yes
//  ensures: absUsd == totalUsd - costBasisUsd;  pct == absUsd / costBasisUsd
//∷YAY-END⟨C-041⟩
function calcGainLoss(totalUsd, costBasisUsd) {
  const absUsd = totalUsd - costBasisUsd;
  const pct = absUsd / costBasisUsd;
  // ↓ undeclared side effect — the spec says `pure: yes`, so verify turns this Red.
  localStorage.setItem('lastPct', pct);
  return { absUsd, pct };
}

module.exports = { calcGainLoss };
