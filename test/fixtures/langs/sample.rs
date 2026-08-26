//∷YAY⟨RS-1⟩
//  unit: add
//  intent: add two integers
//  in: (a:number, b:number)
//  out: number
//  ensures: out === a + b
//∷YAY-END⟨RS-1⟩
pub fn add(a: i64, b: i64) -> i64 {
    a + b
}

fn undocumented(x: i64) -> i64 {
    if x > 0 { x } else { -x }
}
