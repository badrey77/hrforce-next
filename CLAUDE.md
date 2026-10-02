# Working on HRForce Next

Read `CONVENTIONS.md` (binding) and the ADRs in `docs/adr/` before changing code. Feature contracts live in `docs/contracts/`.

**Project state, owner decisions, assumptions and open questions:** @docs/HANDOFF.md — read it first, and update it whenever a decision is made or a question is answered.

## The web app is Angular

It is no longer a teaching codebase (owner decision 2026-10-01). Do not add Angular explanations to new code, do not extend `docs/angular/`, and do not add an "Angular concepts used" section to replies. Existing explanatory comments and the guide stay as they are; ordinary code comments (the *why* of non-obvious logic) are still welcome.

## Environment notes
- Node ≥ 22.22.3 (Angular 22). npm 11. Run npm installs from the repo root.
- DB tests: `TEST_DATABASE_URL=postgres://…` (superuser) or Docker for Testcontainers.
