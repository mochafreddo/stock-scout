---
name: document-generate
description: Generate source-backed documentation for a feature, module, or project using Diataxis.
disable-model-invocation: true
---

# Document Generate

Use this workflow only when the user explicitly invokes it. Follow the repository's instructions, permissions, language rules, and delivery policy. Use the host's available tools; this skill requires no gstack runtime or additional packages.

This skill is adapted from gstack. See [provenance and adaptation notes](UPSTREAM.md) and the [upstream license](LICENSE).

## 1. Establish scope

- Reuse the user's stated target and decisions. If the target, reader, or destination is unclear, ask only for the missing decisions with a recommendation. Use the host's question tool when available, otherwise ask in chat and wait for the answer.
- Identify whether the reader needs a tutorial, a task guide, a reference, an explanation, or a combination. Prefer existing documents for an established topic; add standalone files when the reader needs a separate entry point.
- Read `AGENTS.md`, `CLAUDE.md`, `GLOSSARY.md`, relevant ADRs, and existing documentation before exploring the target. Read the bodies and comments of the product authority and applicable task ticket using the repository's issue workflow.
- Record the current HEAD and selected paths as the review base. Check Git status and preserve unrelated work. Follow the repository's isolation rules before making changes intended for a commit.
- State the target, audience, destinations, and proposed document types. When these are already agreed, proceed. Confirm any expansion beyond the request; if more than five documents are proposed, confirm the plan before writing them.

## 2. Research the target

Map relevant files with `rg --files`, including explicitly selected hidden paths where needed. Limit research to the target and the modules needed to understand it; exclude dependencies, generated output, credentials, and unrelated evidence dumps.

Read the implementation end to end, its public entry points, callers, dependencies, tests, and relevant non-secret configuration definitions. Inspect task definitions before running them. For version-specific behavior, follow the repository's documentation lookup policy and use primary sources.

Before writing, assemble an outline containing:

- Purpose and reader tasks.
- Domain concepts, using the glossary's canonical terms.
- Public commands, options, types, defaults, constraints, and errors within scope.
- Dependencies, affected callers, and edge cases established by code and tests.
- Design rationale supported by ADRs, comments, issues, or history.
- Implemented behavior, planned behavior, and unknowns, kept distinct.

Report the research scope and unresolved questions. Resolve contradictions against the owning source; ask the user about product decisions the sources cannot settle. Never infer an implemented feature or a historical design rationale from a plausible story.

## 3. Partition the documentation

Use Diataxis to serve distinct reader needs. Select only the types the target needs, and keep each type focused. A small topic can use distinct sections in an existing file; four types do not require four new files.

| Type | Reader need | Required content |
| --- | --- | --- |
| Tutorial | Learn through a working example | Concrete outcome, prerequisites, exact steps, visible results, and a recap with next links. Aim for the first working result within three steps. |
| How-to | Complete a specific task | Task-oriented title in the document's language, prerequisites, actionable steps, expected results, verification, and troubleshooting when failure is possible. |
| Reference | Look up precise behavior | Every public item within the agreed scope, including signatures or syntax, types, defaults, constraints, errors, and usable examples where applicable. |
| Explanation | Understand the reasons | Problem, approach, supported rationale, trade-offs, and documented alternatives where available. Link to reference details instead of repeating them. |

Produce a compact plan mapping each file or section to its type and target. Follow existing `docs/` and documentation framework conventions; otherwise use Markdown. Keep agreed domain terms in the glossary without implementation details. Record a decision in an ADR only when it has meaningful reversal cost, would be surprising without context, and reflects a real trade-off.

## 4. Write from evidence

For the selected types, write reference material first, followed by explanations, how-tos, and tutorials. Skip types absent from the plan.

- Trace factual claims to the implementation, tests, specification, or official source that establishes them. Add useful source links; distinguish intended behavior from observed behavior.
- Keep scope-complete coverage without duplicating authoritative material. Link to existing definitions and configuration rather than maintaining another copy when readers do not need the values inline.
- Use exact, safe examples. Prefer captured non-secret output; label illustrative output and placeholders. Do not imply that an unexecuted command or service integration was verified.
- Write agent instructions in English and user-facing documents in Korean, preserving identifiers and official names. Use the repository's register and document style.
- Give actionable steps and observable outcomes. If a tutorial cannot reach a result within three steps, explain the necessary setup instead of inventing a shortcut.
- Explain actual trade-offs and known limits. Use Mermaid or another repository-supported diagram only where it clarifies a relationship.

## 5. Connect the documents

Link related tutorials, task guides, references, and explanations where they exist. Update the README or existing documentation index so each new user-facing document is reachable within two links from the README. Update framework navigation when applicable. Add agent-instruction pointers only when the new document changes how agents should work.

## 6. Verify and review

Inspect the final changed files, including newly added files, against the recorded review base and the agreed plan.

- **Accuracy:** Check claims, signatures, defaults, constraints, errors, and renamed or removed entities against their owners. Verify local link targets, anchors, and navigation.
- **Examples:** Inspect each command's side effects and permissions before execution. Run safe local examples and compare actual results with the stated results. Credential access, paid calls, deployments, destructive steps, and other consequential examples require the task's existing authorization or explicit approval. If an example cannot be run, disclose why and label it unverified.
- **Coverage:** Account for every public item within scope. Cover relevant reader tasks and failures; check tutorial results and explanation trade-offs where those types were selected.
- **Readability:** Check the audience, document type, language, terminology, and concrete instructions. Keep each document's stance consistent.
- **Repository checks:** Run applicable formatting, lint, and tests defined by the repository after inspecting their definitions. Keep the source fixed while checks run. After a fix, repeat affected checks and reviews.
- **Disclosure:** Inspect the changed content for accidental secrets and inappropriate sharing. Follow repository scanning requirements; use placeholders for credentials.

Leave a runnable check when a change introduces non-trivial executable logic, following repository conventions. For prose-only changes, review meaning and verify actual paths and values; do not add tests that assert prose wording. Report skipped checks and distinguish static review, local execution, mocked responses, and live service verification.

## 7. Deliver within authorization

Document generation alone does not request a commit, push, PR update, or publication. Follow the user's request and repository delivery policy for those actions. If delivery is authorized, complete the required review and checks, stage only the intended paths, commit, and verify the remote result after pushing. Preserve unrelated changes.

Report the documented scope, new and updated files by type, quality results, unresolved limits, and any Git delivery performed. State explicitly which examples or integrations were not executed.
