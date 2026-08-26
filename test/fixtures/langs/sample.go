package bank

//∷YAY⟨GO-1⟩
//  unit: Add
//  intent: add two integers
//  in: (a:number, b:number)
//  out: number
//  ensures: out === a + b
//∷YAY-END⟨GO-1⟩
func Add(a int, b int) int {
	return a + b
}

func undocumented(x int) int {
	if x > 0 {
		return x
	}
	return -x
}
