# ADR-002: Health checks are not verification

- Status: Accepted
- Date: 2026-09-15
- Article: 04

## Context

A canary needs a signal to decide whether to advance. The available signals are
health checks, error rates, latency percentiles, and business-level checks. The
first three are nearly free and are what most pipelines use.

## Decision

Require a synthetic business check as its own gate at global radius, separate
from the regression check on error rate and latency.

## Why this option

Because the three cheap signals share a blind spot: a service can be up,
responding quickly, returning HTTP 200, and producing the wrong answer.

Negative control `N3` makes this concrete. The same change is observed with an
error rate of 0.001, a p99 of 190ms against a 200ms baseline, and a failing
business check. With the business check, the rollout halts at 25% exposure.
Without it, every technical signal says healthy and the change reaches 100%.

This is the gate most likely to be skipped, because it is the only one that
requires someone to write down what the system is supposed to do.

## Consequences

Someone has to maintain synthetic business checks, and they rot. The mitigation
is that they are few: one per critical business outcome, not one per endpoint.

## Conditions that would change the decision

None. A release system that cannot tell "up" from "correct" is measuring the
wrong thing, and no amount of additional technical telemetry fixes it.
