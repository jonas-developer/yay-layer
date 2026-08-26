#∷YAY⟨RB-1⟩
#  unit: add
#  intent: add two integers
#  in: (a:number, b:number)
#  out: number
#  ensures: out == a + b
#∷YAY-END⟨RB-1⟩
def add(a, b)
  a + b
end

def undocumented(x)
  if x > 0
    x
  else
    -x
  end
end
