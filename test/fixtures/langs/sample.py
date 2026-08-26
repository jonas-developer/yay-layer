#∷YAY⟨PY-1⟩
#  unit: add
#  intent: add two integers
#  in: (a:number, b:number)
#  out: number
#  ensures: out === a + b
#∷YAY-END⟨PY-1⟩
def add(a, b):
    total = a + b
    return total


def undocumented(x):
    if x > 0:
        return x
    return -x
