public class Calc {
    //∷YAY⟨JAVA-1⟩
    //  unit: add
    //  intent: add two integers
    //  in: (a:number, b:number)
    //  out: number
    //  ensures: out === a + b
    //∷YAY-END⟨JAVA-1⟩
    public int add(int a, int b) {
        return a + b;
    }

    public int undocumented(int x) {
        if (x > 0) { return x; }
        return -x;
    }
}
