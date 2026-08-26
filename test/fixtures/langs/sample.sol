// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Bank {
    //∷YAY⟨SOL-1⟩
    //  unit: deposit
    //  intent: record a deposit for the sender
    //  in: (amount:number)
    //  out: number
    //  ensures: out >= amount
    //∷YAY-END⟨SOL-1⟩
    function deposit(uint amount) public returns (uint) {
        return amount;
    }

    function undocumented(uint x) public returns (uint) {
        if (x > 0) { return x; }
        return 0;
    }
}
