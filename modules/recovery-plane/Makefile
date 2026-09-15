# One command runs everything. No cloud project, no credentials, no network.
#
#   make verify

NODE ?= node
NPX  ?= npx
PY   ?= python3

TESTS = tests/graph.test.ts tests/breakglass.test.ts tests/negative-control.test.ts

.PHONY: help verify test typecheck report secret-scan clean

help:
	@echo "verify        run everything (no cloud project, no credentials, no network)"
	@echo "test          graph, break-glass, and negative controls"
	@echo "typecheck     strict TypeScript check (needs: npm install)"
	@echo "report        validate the recovery graph -> results/"
	@echo "secret-scan   credential scan"
	@echo "clean         remove generated results"

verify: typecheck test report secret-scan
	@echo ""
	@echo "verify: PASS"

test:
	@echo "== graph, break-glass, negative controls =="
	$(NODE) --test $(TESTS)

typecheck:
	@echo "== strict type check =="
	@if [ -d node_modules/typescript ]; then \
		$(NPX) tsc --noEmit -p tsconfig.json && echo "typecheck: PASS"; \
	else \
		echo "typecheck: SKIPPED (run 'npm install' to enable)"; \
	fi

report:
	@echo "== recovery dependency validation =="
	@$(NODE) scripts/report.ts > /dev/null
	@echo "wrote results/validation.json and results/report.md"

secret-scan:
	@echo "== secret scan =="
	@$(PY) scripts/secret-scan.py

clean:
	rm -rf results/*.json results/*.md
