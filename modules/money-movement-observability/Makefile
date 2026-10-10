# One command runs everything. No cloud project, no credentials, no network.
#
#   make verify

NODE ?= node
NPX  ?= npx
PY   ?= python3

TESTS = tests/telemetry.test.ts tests/invariants.test.ts tests/flow.test.ts \
        tests/scenarios.test.ts tests/incident.test.ts

.PHONY: help verify test typecheck report definitions incident secret-scan clean

help:
	@echo "verify        run everything (no cloud project, no credentials, no network)"
	@echo "test          telemetry, invariants, flow, scenarios, incident"
	@echo "typecheck     strict TypeScript check (needs: npm install)"
	@echo "report        run the fault catalogue -> results/"
	@echo "definitions   check definitions/ against the source catalogue"
	@echo "incident      walk one incident end to end (node scripts/incident.ts --help)"
	@echo "secret-scan   credential scan"
	@echo "clean         remove generated results"

verify: typecheck test report definitions secret-scan
	@echo ""
	@echo "verify: PASS"

test:
	@echo "== telemetry, invariants, flow, scenarios, incident =="
	$(NODE) --test $(TESTS)

typecheck:
	@echo "== strict type check =="
	@if [ -d node_modules/typescript ]; then \
		$(NPX) tsc --noEmit -p tsconfig.json && echo "typecheck: PASS"; \
	else \
		echo "typecheck: SKIPPED (run 'npm install' to enable)"; \
	fi

report:
	@echo "== fault catalogue and tallies =="
	@$(NODE) scripts/report.ts > /dev/null
	@echo "wrote results/observability.json and results/report.md"

definitions:
	@echo "== exported definitions drift check =="
	@$(NODE) scripts/export-definitions.ts --check

incident:
	@$(NODE) scripts/incident.ts

secret-scan:
	@echo "== secret scan =="
	@$(PY) scripts/secret-scan.py

clean:
	rm -rf results/*.json results/*.md
