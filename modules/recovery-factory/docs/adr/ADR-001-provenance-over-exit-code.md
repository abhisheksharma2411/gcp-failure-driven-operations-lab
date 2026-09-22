# ADR-001: A restore validates the artifact's provenance, not the job's exit code

- Status: Accepted
- Date: 2026-09-22
- Article: 06

## Context

GitLab's January 2017 incident had five protection mechanisms. The one that
mattered had run:

> "The backup procedure was using `pg_dump` 9.2, while our database is running
> PostgreSQL 9.6."

The job executed, exited, and produced a file. The file was unusable. Nobody
knew, because the failure notification was discarded and, more importantly:

> "Why was the backup procedure not tested on a regular basis? - Because there
> was no ownership, as a result nobody was responsible for testing this
> procedure."

## Decision

Every backup artifact carries provenance — the tool version that wrote it, the
source schema version at capture, and the key reference. The restore path reads
that metadata and refuses an artifact it cannot read, naming the mismatch.

Critically, `takeBackup` can return an artifact whose `payload` is null while
reporting success. The model must be able to represent a job that worked and
produced nothing usable, because that is the failure under study.

## Why this option

The alternative — trusting an exit code — cannot detect this class at all.
Negative control `N1` makes the gap concrete. An exit-code check sees
`state === "INTACT"` and reports "backup OK". Reading the provenance yields
`BLOCKED_UNREADABLE_ARTIFACT` with the tool and schema versions named.

Same artifact. Opposite verdicts. The difference is which question was asked.

## Consequences

Provenance must be captured at backup time, which means the backup tool has to
know its own version and the source's schema version. That is a real
requirement on the implementation and is the point: a tool that cannot describe
what it wrote cannot be verified.

## Conditions that would change the decision

If the storage layer itself verified round-trip readability at write time, the
check would move there, which would be better. Nothing in this lab assumes that
capability exists.
