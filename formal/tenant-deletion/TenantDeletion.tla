---- MODULE TenantDeletion ----
\* Models Rose workspace deletion ordering across two tenants.
\*
\* Code this model tracks (one model step = one of these code steps):
\*   packages/core/src/control/tenants.ts
\*     requestTenantDeletion, cancelTenantDeletion, beginTenantPurge, deleteTenantRecords
\*     setTenantStatus (suspend / resume while not pending/deleting)
\*   packages/core/src/tenant-app.ts
\*     tenantJobHandlers["tenant.purge"]  (grace gate, then begin + storage wipe + records)
\*   packages/core/src/tenancy/context.ts
\*     purgeTenantStorage
\*   packages/core/src/tenancy/tenant-do.ts
\*     assertTenant / purge
\*
\* Discrete Grace ticks stand for DELETE_GRACE_MS (48h). MaxClock bounds the state space.

EXTENDS Integers, FiniteSets, TLC

CONSTANTS Tenants, Grace, MaxClock

ASSUME Grace \in Nat /\ Grace >= 1
ASSUME MaxClock \in Nat /\ MaxClock >= Grace + 1
ASSUME Tenants # {}

\* Sentinel for "no deadline / not destroyed yet" (avoid mixing strings with Int in TLC).
None == -1
NoPrior == "none"
Statuses == {"active", "suspended", "pending_deletion", "deleting", "gone"}

VARIABLES
  status,       \* [t |-> status string]
  deleteAfter,  \* [t |-> Nat or None]
  prior,        \* [t |-> "active"|"suspended"|NoPrior]
  storage,      \* [t |-> BOOLEAN] private DO still holds tenant data
  sessions,     \* [t |-> BOOLEAN] live session with scope = tenant id
  purgeQueued,  \* [t |-> BOOLEAN] tenant.purge job queued for this tenantId
  destroyedAt,  \* [t |-> Nat or None] clock when storage was destroyed
  clock

vars == <<status, deleteAfter, prior, storage, sessions, purgeQueued, destroyedAt, clock>>

TypeOK ==
  /\ status \in [Tenants -> Statuses]
  /\ deleteAfter \in [Tenants -> (0..MaxClock) \cup {None}]
  /\ prior \in [Tenants -> {"active", "suspended", NoPrior}]
  /\ storage \in [Tenants -> BOOLEAN]
  /\ sessions \in [Tenants -> BOOLEAN]
  /\ purgeQueued \in [Tenants -> BOOLEAN]
  /\ destroyedAt \in [Tenants -> (0..MaxClock) \cup {None}]
  /\ clock \in 0..MaxClock

Init ==
  /\ status = [t \in Tenants |-> "active"]
  /\ deleteAfter = [t \in Tenants |-> None]
  /\ prior = [t \in Tenants |-> NoPrior]
  /\ storage = [t \in Tenants |-> TRUE]
  /\ sessions = [t \in Tenants |-> TRUE]
  /\ purgeQueued = [t \in Tenants |-> FALSE]
  /\ destroyedAt = [t \in Tenants |-> None]
  /\ clock = 0

Suspend(t) ==
  /\ status[t] = "active"
  /\ status' = [status EXCEPT ![t] = "suspended"]
  /\ UNCHANGED <<deleteAfter, prior, storage, sessions, purgeQueued, destroyedAt, clock>>

Resume(t) ==
  /\ status[t] = "suspended"
  /\ status' = [status EXCEPT ![t] = "active"]
  /\ UNCHANGED <<deleteAfter, prior, storage, sessions, purgeQueued, destroyedAt, clock>>

\* requestTenantDeletion — sets delete_after = now + grace; clears sessions; queues purge.
RequestDeletion(t) ==
  /\ status[t] \in {"active", "suspended"}
  /\ clock + Grace <= MaxClock
  /\ status' = [status EXCEPT ![t] = "pending_deletion"]
  /\ prior' = [prior EXCEPT ![t] = status[t]]
  /\ deleteAfter' = [deleteAfter EXCEPT ![t] = clock + Grace]
  /\ sessions' = [sessions EXCEPT ![t] = FALSE]
  /\ purgeQueued' = [purgeQueued EXCEPT ![t] = TRUE]
  /\ UNCHANGED <<storage, destroyedAt, clock>>

\* Second request while pending leaves the deadline alone.
ReRequestDeletion(t) ==
  /\ status[t] = "pending_deletion"
  /\ deleteAfter[t] # None
  /\ UNCHANGED vars

\* cancelTenantDeletion — restore prior; drop queued purge; sessions stay cleared.
CancelDeletion(t) ==
  /\ status[t] = "pending_deletion"
  /\ status' = [status EXCEPT ![t] =
        IF prior[t] = "suspended" THEN "suspended" ELSE "active"]
  /\ deleteAfter' = [deleteAfter EXCEPT ![t] = None]
  /\ prior' = [prior EXCEPT ![t] = NoPrior]
  /\ sessions' = [sessions EXCEPT ![t] = FALSE]
  /\ purgeQueued' = [purgeQueued EXCEPT ![t] = FALSE]
  /\ UNCHANGED <<storage, destroyedAt, clock>>

Tick ==
  /\ clock < MaxClock
  /\ clock' = clock + 1
  /\ UNCHANGED <<status, deleteAfter, prior, storage, sessions, purgeQueued, destroyedAt>>

\* Forged / stale job against a workspace that is not scheduled for deletion.
PurgeForgedOrStale(t) ==
  /\ status[t] \in {"active", "suspended"}
  /\ purgeQueued' = [purgeQueued EXCEPT ![t] = FALSE]
  /\ UNCHANGED <<status, deleteAfter, prior, storage, sessions, destroyedAt, clock>>

\* Grace gate: pending but delete_after in the future, or missing deadline — refuse.
PurgeTooEarly(t) ==
  /\ status[t] = "pending_deletion"
  /\ \/ deleteAfter[t] = None
     \/ clock < deleteAfter[t]
  /\ UNCHANGED vars

\* beginTenantPurge — only when pending_deletion AND delete_after <= now.
BeginPurge(t) ==
  /\ status[t] = "pending_deletion"
  /\ deleteAfter[t] # None
  /\ clock >= deleteAfter[t]
  /\ status' = [status EXCEPT ![t] = "deleting"]
  /\ UNCHANGED <<deleteAfter, prior, storage, sessions, purgeQueued, destroyedAt, clock>>

\* purgeTenantStorage + deleteTenantRecords after beginTenantPurge.
DestroyAndWipe(t) ==
  /\ status[t] = "deleting"
  /\ deleteAfter[t] # None
  /\ clock >= deleteAfter[t]
  /\ storage[t] = TRUE
  /\ status' = [status EXCEPT ![t] = "gone"]
  /\ storage' = [storage EXCEPT ![t] = FALSE]
  /\ destroyedAt' = [destroyedAt EXCEPT ![t] = clock]
  /\ sessions' = [sessions EXCEPT ![t] = FALSE]
  /\ purgeQueued' = [purgeQueued EXCEPT ![t] = FALSE]
  /\ prior' = [prior EXCEPT ![t] = NoPrior]
  /\ UNCHANGED <<deleteAfter, clock>>

\* Handler against an already-purged id: no storage left to clear.
PurgeAlreadyGone(t) ==
  /\ status[t] = "gone"
  /\ purgeQueued' = [purgeQueued EXCEPT ![t] = FALSE]
  /\ UNCHANGED <<status, deleteAfter, prior, storage, sessions, destroyedAt, clock>>

Done ==
  /\ clock = MaxClock
  /\ UNCHANGED vars

Next ==
  \/ Tick
  \/ Done
  \/ \E t \in Tenants:
       \/ Suspend(t)
       \/ Resume(t)
       \/ RequestDeletion(t)
       \/ ReRequestDeletion(t)
       \/ CancelDeletion(t)
       \/ PurgeForgedOrStale(t)
       \/ PurgeTooEarly(t)
       \/ BeginPurge(t)
       \/ DestroyAndWipe(t)
       \/ PurgeAlreadyGone(t)

Spec == Init /\ [][Next]_vars

\* ---- invariants ----

\* Private storage is never destroyed before the grace deadline.
\* Harm if broken: the only copy of tenant data (and the wrapped DEK) is wiped while
\* the owner can still cancel inside the advertised 48h window.
NoEarlyPurge ==
  \A t \in Tenants:
    destroyedAt[t] # None =>
      /\ deleteAfter[t] # None
      /\ destroyedAt[t] >= deleteAfter[t]

\* Scheduling, cancelling, or finishing deletion leaves no live session on that scope.
NoSessionAfterSchedule ==
  \A t \in Tenants:
    status[t] \in {"pending_deletion", "deleting", "gone"} => ~sessions[t]

\* After cancel (or while never scheduled), private storage is still there.
StorageSurvivesCancel ==
  \A t \in Tenants:
    status[t] \in {"active", "suspended"} => storage[t]

====
