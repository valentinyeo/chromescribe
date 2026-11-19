---- MODULE Queue ----
EXTENDS Integers, FiniteSets, TLC

CONSTANTS Videos, Drainers, MaxAttempts, MaxShares, EnableCrash, Broken

ASSUME Videos # {}
ASSUME Cardinality(Drainers) >= 2
ASSUME MaxAttempts \in Nat /\ MaxAttempts >= 1
ASSUME MaxShares \in Nat /\ MaxShares >= 1
ASSUME EnableCrash \in BOOLEAN
ASSUME Broken \in {"none", "claim-no-guard", "enqueue-no-dedupe", "crash-no-recovery"}

VARIABLES
  queue,
  nextId,
  phase,
  held,
  sharesLeft,
  enqueued,
  cancelled

Statuses == {"pending", "processing", "done", "failed"}
Phases == {"idle", "listed", "working"}

QueueIds == {r.id : r \in queue}

TypeOK ==
  /\ nextId \in Nat
  /\ sharesLeft \in Nat
  /\ enqueued \subseteq Videos
  /\ cancelled \subseteq Videos
  /\ \A r \in queue :
       /\ r.id \in Nat
       /\ r.video \in Videos
       /\ r.status \in Statuses
       /\ r.attempts \in Nat
  /\ phase \in [Drainers -> Phases]
  /\ held \in [Drainers -> Nat]

Init ==
  /\ queue = {}
  /\ nextId = 1
  /\ phase = [d \in Drainers |-> "idle"]
  /\ held = [d \in Drainers |-> 0]
  /\ sharesLeft = MaxShares
  /\ enqueued = {}
  /\ cancelled = {}

PendingOf(v) == {r \in queue : r.video = v /\ r.status = "pending"}

RowById(id) == CHOOSE r \in queue : r.id = id

HasRow(id) == \E r \in queue : r.id = id

HolderOf(id) == {d \in Drainers : held[d] = id}

Enqueue(v) ==
  /\ sharesLeft > 0
  /\ IF PendingOf(v) # {} /\ Broken # "enqueue-no-dedupe"
     THEN /\ enqueued' = enqueued \cup {v}
          /\ sharesLeft' = sharesLeft - 1
          /\ UNCHANGED <<queue, nextId, phase, held, cancelled>>
     ELSE /\ ~(\E r \in queue : r.video = v /\ r.status = "done")
          /\ queue' = queue \cup {[id |-> nextId, video |-> v, status |-> "pending", attempts |-> 0]}
          /\ nextId' = nextId + 1
          /\ enqueued' = enqueued \cup {v}
          /\ sharesLeft' = sharesLeft - 1
          /\ UNCHANGED <<phase, held, cancelled>>

ListPending(d) ==
  /\ phase[d] = "idle"
  /\ \E r \in queue : r.status = "pending"
  /\ phase' = [phase EXCEPT ![d] = "listed"]
  /\ UNCHANGED <<queue, nextId, held, sharesLeft, enqueued, cancelled>>

Claim(d, id) ==
  /\ phase[d] = "listed"
  /\ HasRow(id)
  /\ held[d] = 0
  /\ IF Broken = "claim-no-guard"
     THEN RowById(id).status \in {"pending", "processing"}
     ELSE /\ RowById(id).status = "pending"
          /\ HolderOf(id) = {}
  /\ queue' = {IF r.id = id
               THEN [r EXCEPT !.status = "processing", !.attempts = r.attempts + 1]
               ELSE r : r \in queue}
  /\ held' = [held EXCEPT ![d] = id]
  /\ phase' = [phase EXCEPT ![d] = "working"]
  /\ UNCHANGED <<nextId, sharesLeft, enqueued, cancelled>>

SkipClaim(d) ==
  /\ phase[d] = "listed"
  /\ phase' = [phase EXCEPT ![d] = "idle"]
  /\ UNCHANGED <<queue, nextId, held, sharesLeft, enqueued, cancelled>>

FinishDone(d) ==
  /\ phase[d] = "working"
  /\ held[d] # 0
  /\ LET id == held[d] IN
       /\ HasRow(id)
       /\ RowById(id).status = "processing"
       /\ queue' = {IF r.id = id THEN [r EXCEPT !.status = "done"] ELSE r : r \in queue}
       /\ held' = [held EXCEPT ![d] = 0]
       /\ phase' = [phase EXCEPT ![d] = "idle"]
       /\ UNCHANGED <<nextId, sharesLeft, enqueued, cancelled>>

FinishFailed(d) ==
  /\ phase[d] = "working"
  /\ held[d] # 0
  /\ LET id == held[d] IN
       /\ HasRow(id)
       /\ RowById(id).status = "processing"
       /\ queue' = {IF r.id = id THEN [r EXCEPT !.status = "failed"] ELSE r : r \in queue}
       /\ held' = [held EXCEPT ![d] = 0]
       /\ phase' = [phase EXCEPT ![d] = "idle"]
       /\ UNCHANGED <<nextId, sharesLeft, enqueued, cancelled>>

RetryFailed(id) ==
  /\ HasRow(id)
  /\ RowById(id).status = "failed"
  /\ RowById(id).attempts < MaxAttempts
  /\ PendingOf(RowById(id).video) = {}
  /\ queue' = {IF r.id = id THEN [r EXCEPT !.status = "pending"] ELSE r : r \in queue}
  /\ UNCHANGED <<nextId, phase, held, sharesLeft, enqueued, cancelled>>

DeleteRow(id) ==
  /\ HasRow(id)
  /\ RowById(id).status # "processing"
  /\ LET v == RowById(id).video IN
       /\ queue' = {r \in queue : r.id # id}
       /\ cancelled' = cancelled \cup {v}
       /\ UNCHANGED <<nextId, phase, held, sharesLeft, enqueued>>

Recover(id) ==
  /\ Broken # "crash-no-recovery"
  /\ HasRow(id)
  /\ RowById(id).status = "processing"
  /\ HolderOf(id) = {}
  /\ IF RowById(id).attempts < MaxAttempts
     THEN /\ PendingOf(RowById(id).video) = {}
          /\ queue' = {IF r.id = id
                       THEN [r EXCEPT !.status = "pending", !.attempts = r.attempts + 1]
                       ELSE r : r \in queue}
     ELSE queue' = {IF r.id = id THEN [r EXCEPT !.status = "failed"] ELSE r : r \in queue}
  /\ UNCHANGED <<nextId, phase, held, sharesLeft, enqueued, cancelled>>

Crash(d) ==
  /\ EnableCrash
  /\ phase[d] = "working"
  /\ held[d] # 0
  /\ held' = [held EXCEPT ![d] = 0]
  /\ phase' = [phase EXCEPT ![d] = "idle"]
  /\ UNCHANGED <<queue, nextId, sharesLeft, enqueued, cancelled>>

StutterEnd ==
  /\ sharesLeft = 0
  /\ \A d \in Drainers : phase[d] = "idle"
  /\ \A r \in queue : r.status \in {"done", "failed"}
  /\ UNCHANGED <<queue, nextId, phase, held, sharesLeft, enqueued, cancelled>>

Next ==
  \/ \E v \in Videos : Enqueue(v)
  \/ \E d \in Drainers : ListPending(d)
  \/ \E d \in Drainers : SkipClaim(d)
  \/ \E d \in Drainers, id \in QueueIds : Claim(d, id)
  \/ \E d \in Drainers : FinishDone(d)
  \/ \E d \in Drainers : FinishFailed(d)
  \/ \E id \in QueueIds : Recover(id)
  \/ \E id \in QueueIds : RetryFailed(id)
  \/ \E id \in QueueIds : DeleteRow(id)
  \/ \E d \in Drainers : Crash(d)
  \/ StutterEnd

vars == <<queue, nextId, phase, held, sharesLeft, enqueued, cancelled>>

Fairness ==
  /\ SF_vars(\E v \in Videos : Enqueue(v))
  /\ SF_vars(\E id \in QueueIds : Recover(id))
  /\ \A d \in Drainers :
       /\ SF_vars(ListPending(d))
       /\ SF_vars(SkipClaim(d))
       /\ SF_vars(\E id \in QueueIds : Claim(d, id))
       /\ SF_vars(FinishDone(d))
       /\ SF_vars(FinishFailed(d))

Spec == Init /\ [][Next]_vars /\ Fairness

NoDupPending ==
  \A v \in Videos : Cardinality(PendingOf(v)) <= 1

NoDoubleProcess ==
  /\ \A r \in queue :
       r.status = "processing" => Cardinality(HolderOf(r.id)) <= 1
  /\ \A d1, d2 \in Drainers :
       (d1 # d2 /\ held[d1] # 0) => held[d1] # held[d2]

NoLost ==
  \A v \in enqueued :
    \/ v \in cancelled
    \/ \E r \in queue : r.video = v

Recovers ==
  \A v \in Videos :
    []( (v \in enqueued) =>
          <> (v \in cancelled \/ \E r \in queue : r.video = v /\ r.status \in {"done", "failed"}) )

Bound ==
  /\ nextId <= MaxShares + 2
  /\ Cardinality(queue) <= MaxShares + 1
  /\ sharesLeft >= 0

====
