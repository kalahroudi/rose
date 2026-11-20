---- MODULE Toy ----
EXTENDS Integers

CONSTANT MUTANTS

VARIABLE counter

Init == counter = 0

GuardHolds == counter < 2
DropGuard == "drop-guard" \in MUTANTS

Inc ==
  /\ counter < 3
  /\ (GuardHolds \/ DropGuard)
  /\ counter' = counter + 1

Done ==
  /\ counter = 2
  /\ UNCHANGED counter

Next == Inc \/ Done

CounterLeqBound == counter <= 2

Spec == Init /\ [][Next]_counter
====
