// A higher-order Cell (a "module"): it declares `contains` instead of governing
// its own code. Its color rolls up to the worst of the Cells it contains — so
// because C-041 is Red, C-900 shows Red too, and you can trace the problem up
// the tree. Convention: container Cells live in a high id range (C-900+).

//∷YAY⟨C-900⟩ v1
//  unit:     Portfolio
//  lang:     js
//  intent:   The portfolio feature — total value + gain — composed of its calc Cells.
//  contains: C-040, C-041
//∷YAY-END⟨C-900⟩
