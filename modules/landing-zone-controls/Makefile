# One command runs everything. No cloud project, no credentials, no network.
#
#   make verify
#
# Nothing here applies Terraform. `tf-check` formats and validates only.

NODE ?= node
NPX  ?= npx
PY   ?= python3

TESTS = tests/hierarchy.test.ts tests/identity.test.ts tests/policy.test.ts \
        tests/perimeter.test.ts tests/audit.test.ts tests/suite.test.ts \
        tests/policies.test.ts

.PHONY: help verify test typecheck report policies tf-check secret-scan clean

help:
	@echo "verify        run everything (no cloud project, no credentials, no network)"
	@echo "test          hierarchy, identity, policy, perimeter, audit, suite, policy-as-code"
	@echo "typecheck     strict TypeScript check (needs: npm install)"
	@echo "report        run every experiment -> results/"
	@echo "policies      check policies/landing-zone.json against the model"
	@echo "tf-check      terraform fmt and validate; never apply"
	@echo "secret-scan   credential scan"
	@echo "clean         remove generated results"

verify: typecheck test report policies tf-check secret-scan
	@echo ""
	@echo "verify: PASS"

test:
	@echo "== landing-zone controls =="
	$(NODE) --test $(TESTS)

typecheck:
	@echo "== strict type check =="
	@if [ -d node_modules/typescript ]; then \
		$(NPX) tsc --noEmit -p tsconfig.json && echo "typecheck: PASS"; \
	else \
		echo "typecheck: SKIPPED (run 'npm install' to enable)"; \
	fi

report:
	@echo "== guardrail and golden-path experiments =="
	@$(NODE) scripts/report.ts > /dev/null
	@echo "wrote results/landing-zone-controls.json and results/report.md"

policies:
	@echo "== policy-as-code drift check =="
	@$(NODE) scripts/render-policies.ts --check

# Formatting is checked always. `validate` needs the provider, which needs the
# registry, so it degrades to SKIPPED offline rather than failing the build.
tf-check:
	@echo "== terraform =="
	@if ! command -v terraform >/dev/null 2>&1; then \
		echo "terraform: SKIPPED (terraform not installed)"; \
	elif ! terraform -chdir=infra fmt -check; then \
		echo "terraform: FAIL (formatting)"; exit 1; \
	elif terraform -chdir=infra init -backend=false -input=false >/dev/null 2>&1; then \
		terraform -chdir=infra validate; \
	else \
		echo "terraform: SKIPPED (provider registry unreachable; fmt checked, validate needs network)"; \
	fi

secret-scan:
	@echo "== secret scan =="
	@$(PY) scripts/secret-scan.py

clean:
	rm -rf results/*.json results/*.md
