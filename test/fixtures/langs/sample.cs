public class Calc
{
    //∷YAY⟨CS-1⟩
    //  unit: Add
    //  intent: add two integers
    //  in: (a:number, b:number)
    //  out: number
    //  ensures: out === a + b
    //∷YAY-END⟨CS-1⟩
    public int Add(int a, int b)
    {
        return a + b;
    }

    public int Undocumented(int x)
    {
        if (x > 0) { return x; }
        return -x;
    }
}
