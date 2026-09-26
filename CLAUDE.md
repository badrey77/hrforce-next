# Working on HRForce Next

Read `CONVENTIONS.md` (binding) and the ADRs in `docs/adr/` before changing code. Feature contracts live in `docs/contracts/`.

**Project state, owner decisions, assumptions and open questions:** @docs/HANDOFF.md — read it first, and update it whenever a decision is made or a question is answered.

## The web app is Angular, and it is also a teaching codebase

The team chose to stay on Angular and wants Angular explained extensively as the project grows.
Whenever you add or change code in `apps/web`:

1. **Explain in the code.** Each new component, service, directive, pipe, guard or interceptor starts with a comment block that says what Angular concept it uses and why (e.g. "`inject()` asks the dependency-injection system for…", "`computed()` re-runs only when…"). Explain the first use of each template feature (`@if`, `@for` with `track`, `[prop]`, `(event)`, `[(ngModel)]`-style two-way binding, pipes). Explain the *why*, not just the *what*. Do not explain plain TypeScript.
2. **Update the guide.** `docs/angular/` is a guide that teaches Angular through this repo's real files. When you introduce a concept the guide does not cover yet, add or extend a chapter, linking to the file that shows it.
3. **Explain in your reply.** When reporting work on the web app, include a short "Angular concepts used" section for the person reading.

## Environment notes
- Node ≥ 22.22.3 (Angular 22). npm 11. Run npm installs from the repo root.
- DB tests: `TEST_DATABASE_URL=postgres://…` (superuser) or Docker for Testcontainers.
