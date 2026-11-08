----------------------------- MODULE Delivery -----------------------------
EXTENDS Integers
CONSTANT Fault
VARIABLE s

\* Original independent TLA+ translation of Exomina's finite delivery model.
\* Null approval fields are represented by -1. No fairness/liveness asserted.
Init == s = [stage |-> "pending", epoch |-> 0, revision |-> 0,
             approvedEpoch |-> -1, approvedRevision |-> -1, effects |-> 0,
             unresolved |-> FALSE, badAuthorization |-> FALSE,
             replayedUnknown |-> FALSE]
Authorized == s.approvedEpoch = s.epoch /\ s.approvedRevision = s.revision
Revoke == /\ s.epoch = 0 /\ s.stage # "done"
          /\ s' = [s EXCEPT !.epoch = 1]
Change == /\ s.revision = 0 /\ s.stage \in {"pending","approved","committed"}
          /\ s' = [s EXCEPT !.revision = 1]
Approve == /\ s.stage = "pending"
           /\ s' = [s EXCEPT !.stage = "approved", !.approvedEpoch = s.epoch,
                              !.approvedRevision = s.revision]
Checkpoint == /\ s.stage = "approved"
              /\ s' = [s EXCEPT !.stage = IF Authorized THEN "committed" ELSE "blocked"]
Invoke == /\ s.stage = "committed"
          /\ (Authorized \/ Fault = "skip-final-authorization")
          /\ s.effects < 2
          /\ s' = [s EXCEPT !.stage = "sending", !.effects = s.effects + 1,
                             !.badAuthorization = ~Authorized,
                             !.replayedUnknown = s.unresolved]
Block == /\ s.stage = "committed" /\ ~Authorized
         /\ Fault # "skip-final-authorization"
         /\ s' = [s EXCEPT !.stage = "blocked"]
Crash == /\ s.stage = "committed"
         /\ s' = [s EXCEPT !.stage = "unknown", !.unresolved = TRUE]
Ack == /\ s.stage = "sending"
       /\ s' = [s EXCEPT !.stage = "done", !.unresolved = FALSE]
LoseAck == /\ s.stage = "sending"
           /\ s' = [s EXCEPT !.stage = "unknown", !.unresolved = TRUE]
ConfirmDelivered == /\ s.stage = "unknown"
                    /\ s' = [s EXCEPT !.stage = "done", !.unresolved = FALSE]
ConfirmNotSent == /\ s.stage = "unknown" /\ s.effects < 2
                  /\ s' = [s EXCEPT !.stage = "pending", !.unresolved = FALSE]
RetryUnknown == /\ s.stage = "unknown" /\ s.effects < 2
                /\ Fault = "replay-unknown"
                /\ s' = [s EXCEPT !.stage = "pending"]
ReviewAgain == /\ s.stage = "blocked"
               /\ s' = [s EXCEPT !.stage = "pending"]
Next == Revoke \/ Change \/ Approve \/ Checkpoint \/ Invoke \/ Block \/ Crash
        \/ Ack \/ LoseAck \/ ConfirmDelivered \/ ConfirmNotSent \/ RetryUnknown
        \/ ReviewAgain
Safety == ~s.badAuthorization /\ ~s.replayedUnknown
=============================================================================
