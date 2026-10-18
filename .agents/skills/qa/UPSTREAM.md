# Provenance

This repository adapts `qa` from [garrytan/gstack](https://github.com/garrytan/gstack), copyright (c) 2026 Garry Tan, under the [MIT license](LICENSE).

- Source revision: `25dbe34f4228fc3d920101472f29477bd5023c0e`.
- [Original skill at that revision](https://github.com/garrytan/gstack/blob/25dbe34f4228fc3d920101472f29477bd5023c0e/qa/SKILL.md).
- [Original scope, exploratory, and functional sections](https://github.com/garrytan/gstack/tree/25dbe34f4228fc3d920101472f29477bd5023c0e/qa/sections).
- [Original license at that revision](https://github.com/garrytan/gstack/blob/25dbe34f4228fc3d920101472f29477bd5023c0e/LICENSE).

## Adaptation

The maintained workflow preserves scoped functional exploration, isolated fixtures, contract outcomes, replay before repair, a failing native regression, minimal fixes, revalidation, and a final evidence report. It includes Full, Quick, and Regression exploration, severity-based repair tiers, and an explicit report-only option in one skill.

This adaptation targets the project's CLI. It omits browser setup, visual scores, browser framework bootstrap, and API/job/worker/webhook-specific procedures. Add another surface only when the product and task require it. The current product specification and task ticket remain authoritative; the skill does not turn planned product features into repair work.

Host-neutral instructions replace gstack startup, evidence and deadline binaries, question tooling, cross-project learning, artifact synchronization, telemetry, and automatic per-fix commits. Native commands and host tools retain evidence with explicit completion results and timeouts. This is a procedural adaptation, not an implementation of gstack's automated evidence recorder or secret scanner. The agent must check safe output and disclose withheld evidence.

Agent instructions are English; reports and user-facing guidance are Korean. Live calls and consequential actions stay within specific existing authorization. Actions remain disabled. Commit, push, and external publication follow the task request and repository policy rather than occurring automatically.

The authoritative directory is `.agents/skills/qa/`. `.claude/skills/qa` is a relative symlink to it. Claude Code uses explicit invocation through skill frontmatter; Codex uses `agents/openai.yaml` with implicit invocation disabled. Other hosts can read the same skill when explicitly requested; discovery is host-specific.

## Updates

Compare proposed upstream changes with the pinned revision and port relevant functional QA improvements against the current project contract. Update the revision and source links together and preserve the MIT license. Updating this adaptation does not authorize installing gstack or restoring its runtime behavior.
