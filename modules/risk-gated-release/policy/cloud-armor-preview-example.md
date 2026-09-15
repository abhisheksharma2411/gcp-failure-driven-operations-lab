# A harmless Cloud Armor rule, staged

The 2019 failure was a WAF rule that reached the whole fleet in seconds.
Cloud Armor's preview mode is the direct answer, and it is worth showing
because it is the cheapest gate in this entire article to adopt.

> "You can preview the effects of a rule without enforcing it. In preview mode,
> actions are noted in Cloud Monitoring."

Evaluation does not stop at a previewed rule:

> "If a request triggers a preview, Cloud Armor continues to evaluate other
> rules until finding a match."

## The staged sequence

```bash
# 1. Add the rule in preview. It matches, it is logged, it does not act.
gcloud compute security-policies rules create 1000 \
  --security-policy=example-policy \
  --expression="request.path.matches('/admin')" \
  --action=deny-403 \
  --preview

# 2. Observe. This is the phase that did not exist in 2019.
#    Look at how many requests matched, and whether any of them were
#    requests you wanted to keep serving.

# 3. Enforce only after the observation says what you expected.
gcloud compute security-policies rules update 1000 \
  --security-policy=example-policy \
  --no-preview

# 4. The recovery path, proved before step 3 rather than discovered after it.
gcloud compute security-policies rules update 1000 \
  --security-policy=example-policy \
  --preview
```

Step 4 is the one teams skip. A rule that can be returned to preview in one
command has a recovery path; a rule that can only be deleted does not, because
deleting it is a second change with its own blast radius.

## What preview does not do

It does not tell you the rule is correct. It tells you what the rule *matches*
on real traffic, which is a different and more useful thing than a syntax check.

The Cloudflare failure would not have been caught by a syntax check either: the
regular expression was valid. It was catastrophic backtracking under real
input, and the only way to see that is to run it against real input somewhere
that is not everywhere.

## Cost

Preview is not free:

> "are charged the normal per-request fee for rules in preview mode"

That is the correct trade and worth stating plainly. You pay per-request rates
for a rule that is not protecting you yet, in exchange for knowing what it will
do before it does it.
