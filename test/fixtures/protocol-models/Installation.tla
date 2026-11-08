--------------------------- MODULE Installation ---------------------------
EXTENDS Integers
CONSTANT Fault
VARIABLE s

\* The finite abstraction omits individual mark identity after applying the
\* predicate, exactly as the JS explorer does. Two symbolic build identities
\* are represented by the matching boolean.
Init == s = [stage |-> "approved", accepted |-> FALSE, valid |-> FALSE]
HostInstalled(host,kind,status,matching) ==
  host /\ kind = "update_installed" /\ status = "verified" /\ matching
Observe(host,kind,status,matching) ==
  /\ s.stage = "approved"
  /\ s' = [stage |-> "settled",
           accepted |-> IF Fault = "trust-staged-mark"
                        THEN host /\ kind = "update_staged" /\ status = "verified" /\ matching
                        ELSE HostInstalled(host,kind,status,matching),
           valid |-> HostInstalled(host,kind,status,matching)]
Next == \E host \in BOOLEAN, kind \in {"file","update_staged","update_installed"},
           status \in {"verified","contradicted","unavailable"}, matching \in BOOLEAN:
           Observe(host,kind,status,matching)
Safety == ~s.accepted \/ s.valid
=============================================================================
