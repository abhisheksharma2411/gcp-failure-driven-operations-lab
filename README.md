# gcp-failure-driven-operations-lab

Runnable labs for the operations half of *Failure-Driven Architecture on
Google Cloud*.

Each module is small, runs in one command, needs no cloud project, and proves
one specific claim from its companion article.

| Module | Article | Proves |
|---|---|---|
| [`risk-gated-release`](modules/risk-gated-release) | 4 — Safe global releases | Required release gates follow blast radius rather than change type, and staging bounds exposure when a change is wrong |
| [`recovery-plane`](modules/recovery-plane) | 5 — Out-of-band recovery | A recovery step that depends on the domain it repairs cannot run when it is needed, and independence must be derived from the graph rather than declared |
| [`recovery-factory`](modules/recovery-factory) | 6 — Tested disaster recovery | A backup job completing is not evidence of recoverability; provenance is checked rather than exit codes trusted, and completion is independent of correctness |

Planned, created only when the first article that needs them is written:
zero-trust landing zone (Article 9) and payment observability (Article 22). An empty
repository is not a contribution.

## Running anything here

```bash
cd modules/<module>
make verify
```

No credentials, no network, no billing account.

## Licence

Apache-2.0.
