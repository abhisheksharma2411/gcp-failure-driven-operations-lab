# Runbook: restore corporate DNS resolution

**This runbook is printed.** That is not nostalgia. A runbook stored in the
wiki depends on the wiki, which depends on DNS and the primary identity
provider. During the failure this runbook exists for, it would be unreachable.

The validator flags exactly that: `restore-dns → wiki-runbooks → corp-dns`.

## Before you start

You need, physically:

- A hardware token. Not a push notification, which needs a phone that needs a
  network that may be the thing that is broken.
- This sheet.

You do not need, and must not wait for: chat, the wiki, the bastion, the admin
console, or the CI pipeline. Every one of them is inside the failure domain.

## Steps

1. Authenticate to the recovery identity path using the hardware token. This
   path does not federate through the primary identity provider; if it did, it
   would not be a recovery path.

2. Request a break-glass grant. State the incident number as the justification.
   The grant is time-bounded and will expire on its own; do not plan around
   extending it.

3. Obtain approval from a second person on the approver list. If you are on
   both lists, you still cannot approve your own request.

4. Reach the out-of-band console. It has no dependency on corporate DNS or the
   corporate network.

5. Perform the repair.

6. Stop. Let the grant expire rather than revoking it manually — expiry is
   automatic and does not depend on anyone remembering.

## Afterwards

Nothing to do for the record. The grant, its justification, its approver and
its expiry are already in Admin Activity audit logs, which "are always written;
you can't configure, exclude, or disable them."

That is the property that makes this whole path auditable: the record does not
depend on you, and it does not depend on the systems that failed.

## What this runbook does not cover

Restoring anything other than corporate DNS resolution. If the repair requires
a step not listed here, that step has not been validated against the dependency
graph, and running it under pressure is how a recovery plane becomes a normal
daily path.
