# Provenance

This repository adapts `document-generate` from [garrytan/gstack](https://github.com/garrytan/gstack), copyright (c) 2026 Garry Tan, under the [MIT license](LICENSE).

- Source revision: `d258bcffb0cb7bda5f133f3e957f932d816d282f`.
- [Original skill at that revision](https://github.com/garrytan/gstack/blob/d258bcffb0cb7bda5f133f3e957f932d816d282f/document-generate/SKILL.md).
- [Original license at that revision](https://github.com/garrytan/gstack/blob/d258bcffb0cb7bda5f133f3e957f932d816d282f/LICENSE).

## Adaptation

The shared workflow preserves source research, Diataxis partitioning, reference-first writing, document linking, and quality review. It replaces the generated gstack preamble and tool names with host-neutral instructions. It omits gstack onboarding, session recovery, question preferences, artifact synchronization, decision and learning logs, telemetry, and runtime secret-scanner commands. Repository permissions and disclosure checks still apply.

User-facing documents follow this repository's Korean conventions. Automatic commit, push, and PR updates are replaced with delivery bounded by the user's request and repository policy. Both hosts use explicit invocation: Claude Code reads the skill frontmatter; Codex reads `agents/openai.yaml`.

The authoritative directory is `.agents/skills/document-generate/`. `.claude/skills/document-generate` is a relative symlink to it, so both agents read one copy. The same `SKILL.md` can be read by other agents when explicitly requested; their discovery and invocation mechanisms are host-specific.

## Updates

This is a maintained adaptation, not generated output. Compare a proposed upstream revision with the pinned source, port relevant documentation improvements, and review them against the current repository contract. Update the revision and source links together, preserving the upstream license. Updating the source does not authorize installing gstack or restoring its runtime behavior.
