# AGENTS.md

- Use [#237](https://github.com/mochafreddo/stock-scout/issues/237) and the task's ticket as the authority for product requirements. Read their bodies and comments before starting work. Do not automatically inherit strategy or verification requirements from the previous implementation.
- Start with the minimum necessary implementation. Use TypeScript and the Vercel AI SDK for the first version, scoped to a CLI.
- Use the GitHub CLI from this repository to read, create, and update issues. Write multiline bodies to a file and pass it with `--body-file`.
- Read `GLOSSARY.md` and relevant `docs/adr/` entries before exploring the code or domain. Record agreed domain terms in the glossary and long-term design decisions in ADRs.
- Write documents primarily consumed by agents in English, including `AGENTS.md`, agent skills, and agent task instructions. Write other documents in Korean, including `README.md`, `GLOSSARY.md`, ADRs, user guides, and issues. Preserve code identifiers and official names in their original form.
- Commit and push directly to `main` as needed. History replacement and force-pushing were authorized only for the initialization in #238; obtain separate approval for subsequent uses.
- Keep Actions disabled. Run required verification locally and distinguish mocked checks from live service integration checks.
- Do not commit or print environment files or credentials. Follow the specification and approved storage locations when storing new credentials.
- Keep `CLAUDE.md` as a reference to this file. Maintain shared instructions here and edit this file in place.
