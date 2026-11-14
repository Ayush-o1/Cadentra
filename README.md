# Cadentra

A permission-based outbound email platform: manage contacts, run multi-step email sequences, and track what actually happened to every message.

**Status: Phase 0 (research and planning). No application code exists yet.**

Nothing in this repository is deployed. A live URL will be added here only after it has been deployed and verified.

## Planned stack

Node.js 24, TypeScript, Express 5, MySQL 8.4, Prisma 7, Zod, Vitest. The frontend is plain HTML, CSS and JavaScript modules. These choices are proposals until the Phase 0 review is approved; see [docs/DECISIONS.md](docs/DECISIONS.md).

## Documentation

| Document                                                     | Purpose                                                                            |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [docs/RESEARCH.md](docs/RESEARCH.md)                         | What was inspected, what was verified, and the evidence behind the recommendations |
| [docs/PRODUCT_REQUIREMENTS.md](docs/PRODUCT_REQUIREMENTS.md) | Product definition, MVP scope, and the post-MVP list                               |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                 | System design, background jobs, email integration, security approach               |
| [docs/DATABASE_DESIGN.md](docs/DATABASE_DESIGN.md)           | Draft schema direction, constraints, indexes, transactions                         |
| [docs/DECISIONS.md](docs/DECISIONS.md)                       | Decision log with alternatives and trade-offs                                      |
| [docs/ROADMAP.md](docs/ROADMAP.md)                           | Phases 1 to 10 with acceptance criteria and the Git workflow                       |

Further documents (API reference, security, testing, deployment) are created in the phase that produces their content.
