# AGENTS.md

## Mission Statement

This project exists to build a high-quality ComfyUI extension for exporting, importing, and working with SugarCubes as stable, reusable workflow units.
Engineering priority is maintainability, clear architecture, behavior safety during change, and predictable runtime behavior.

## Purpose

- This file defines engineering guardrails for this repository.
- This file governs architecture, behavior safety, code quality, typing, testing, security, and verification.
- Do not use this file for feature specs or product planning.

## Behavior Boundary

- Preserve existing user-facing behavior unless a behavior change is intentional, explicitly called out, and covered by tests.
- Preserve `.cube` compatibility and persisted project data unless an intentional breaking change is explicitly approved.
- Treat current behavior and persisted cube data as the contract; change internals freely within that boundary.

## Core Engineering Principles

- Ship production-quality code with clear intent, predictable behavior, and thorough validation.
- Use strong separation of concerns and keep architectural boundaries explicit.
- Assign one authoritative owner per concern; collaborating components must derive behavior from that owner rather than re-implementing the concern in parallel.
- Reassess ownership before extending an existing structure; if a change introduces a distinct responsibility, change cadence, or collaboration boundary, split or extract it as part of the change instead of deferring cleanup.
- Favor DRY when it reduces repeated change risk.
- Do not force DRY when abstraction harms clarity.
- Refactors must be complete: update callsites, remove dead code, and remove temporary bridges.
- Do not preserve backward compatibility for internal code unless the public or host-facing contract requires it.
- Leave the campsite cleaner: tighten naming, remove dead paths, and align touched code with this file.

## Architecture Rules

- Organize code into clear layers with one-way dependencies.
- Presentation concerns own UI rendering, user interaction wiring, and host-facing request/response surfaces.
- Application and orchestration concerns own import and export workflows, graph coordination, and use-case sequencing.
- Domain concerns own cube semantics, validation rules, bindings, and serialization meaning.
- Infrastructure and adapter concerns own ComfyUI integration, filesystem IO, browser and runtime hooks, and other external-system boundaries.
- Higher-level concerns may depend on lower-level concerns; lower-level concerns must not depend on higher-level concerns.
- Place code by ownership and dependency direction, not convenience, proximity, or current folder shape.
- Avoid god classes and monolithic modules; split by responsibility, not by convenience.

## Structural Change Rules

- For behavior-critical areas, work in two steps:
  1. Add characterization or regression tests for existing behavior.
  2. Perform structural changes behind those tests.
- Do not start structural changes in an area without behavior safeguards for that area.
- When behavior spans multiple components, trace the current ownership and data flow before editing; prefer correcting the ownership model over layering compensating patches across consumers.
- Prefer vertical slices that land safely over large unverified rewrites.
- If behavior changes are intentional, call them out explicitly and cover them with tests.
- Current module layout does not constrain improvement; reorganize freely when it improves architecture and respects the dependency rules in this file.

## Code Organization and Readability

- Write self-documenting code with expressive, concise names.
- Organize modules, classes, and methods intentionally so code flow is easy to follow.
- Place new code deliberately, not opportunistically.
- Keep modules cohesive and avoid mixed responsibilities.
- Optimize for maintainability over cleverness. When performance matters, measure and document the rationale.

## Docstrings and Comments

- Docstrings are mandatory for new and changed modules, classes, functions, and methods.
- Use concise imperative docstrings for simple logic.
- Use Google-style docstrings for complex logic.
- Docstrings must explain rationale, constraints, and intent; they must not restate obvious mechanics.
- Inline comments are only for non-obvious behavior, invariants, edge cases, or external constraints.

## Documentation Policy

- Do not create extra docs files unless explicitly requested.
- Required context should live in code, type hints, tests, and docstrings.
- Keep documentation concise and directly useful.

## Typing Policy

- Strong typing is required for new code.
- Modified code should be typed as part of the change.
- Type hints are required on new and changed Python function signatures.
- Prefer explicit domain types and type narrowing over `Any`.
- Avoid untyped escape hatches unless justified inline.

## Logging, Errors, and Observability

- Observability is mandatory.
- Use structured, actionable logging with enough context to diagnose failures quickly.
- Preserve exception context and stack traces for unexpected failures.
- Do not use `print` for runtime diagnostics.
- Bare `except:` is not allowed.
- `except Exception` must be narrow, intentional, and log actionable context plus failure reason.
- Silent exception swallowing is not allowed.

## Security and Safety Rules

- Treat imported cube data, custom-node installation, subprocess execution, external paths, and network access as security-sensitive.
- Never execute untrusted code paths without explicit trust and validation checks.
- Validate and sanitize user-provided paths, uploaded files, and imported file references.
- Use subprocess argument lists; do not construct shell-string execution for runtime operations.
- Set explicit timeouts for network operations.
- Fail closed when trust, validation, or external verification is uncertain.
- Never log secrets, tokens, credentials, or sensitive local paths beyond what is necessary for diagnosis.

## DOM Safety Rules

- Never render dynamic values with `innerHTML`, `outerHTML`, or `insertAdjacentHTML`.
- Build DOM with `document.createElement`, `textContent`, `replaceChildren`, and explicit attribute assignment.
- Treat all dynamic values as untrusted for DOM rendering, including cube metadata, workflow content, server payloads, query-state values, and imported data.
- Detached parsing helpers may use `innerHTML` only when the created node is never attached to the live document and the code only extracts normalized text or strictly validated structure.
- Every detached-parsing exception must include a short inline comment explaining why it is safe.
- UI changes that render dynamic text should include regression coverage proving markup-like content is rendered literally rather than parsed as DOM.

## Dialog and Feedback Rules

- User-facing SugarCubes dialogs, confirmations, prompts, blocking errors, and fallback error displays must use the SugarCubes modal/dialog system.
- Prefer existing dialog services and classes: `ModalService`, `ConfirmDialog`, `InputModal`, `FormModal`, `SelectionModal`, and purpose-built modal classes for specialized flows.
- Use `ToastService` for non-blocking notifications. If the host toast API is unavailable, fallback display must still use SugarCubes UI, not browser-native dialogs.
- Do not call browser-native `alert`, `confirm`, or `prompt` from SugarCubes product code.
- Do not add adapter-level browser dialog fallbacks for normal SugarCubes UX.
- If a host integration absolutely requires a browser primitive, isolate it behind an adapter boundary, document why the host requires it, and do not use it for ordinary product feedback.
- UI changes that add or alter dialog/error fallback behavior should include tests proving the SugarCubes modal/toast path is used and native browser dialogs are not invoked.

## Tooling and Verification

- Run `npm run check` before reporting success.
- `npm run check` is the repository quality gate and must remain green for completed changes unless an explicit blocker is reported.
- Copyright headers must be maintained with `python tools/add_license_headers.py`.
- Import ComfyUI core modules (`/scripts/app.js`, `/scripts/ui.js`, `/scripts/api.js`) via absolute `/scripts/...` paths to avoid extension-relative 404s.
- Keep Jest mappings in `jest.config.cjs` aligned with any `/scripts/...` imports used by web modules.

## Testing Policy

- Add or update tests for every behavior change and every bug fix.
- Add characterization tests before structural changes in behavior-critical areas.
- New behavior must not be left unverified.
- Include regression tests for fixed bugs.
- Cover success and failure paths.
- Keep tests deterministic and isolated.
- Prefer real behavior tests over excessive mocking; mock only external boundaries.
- UI-critical behavior should be covered by automated tests when feasible.
- Failing tests are blocking.

## Verification Workflow

- Run focused checks during implementation.
- Verify the specific reported behavior directly when feasible; do not declare a UI or interaction issue fixed from code inspection alone.
- Run the full repository gate before reporting completion.
- Distinguish observed results from inferred results in progress updates and completion reports.
- Do not introduce new lint, format, or test failures in modified files.
- Do not report completion if any blocking gate fails.
- If a gate is intentionally deferred, explicitly state the reason and risk.

## Definition of Done

- Behavior is safeguarded by tests appropriate to the change.
- New or modified code follows the architecture, ownership, and safety rules in this file.
- New or modified code is placed according to responsibility and dependency direction.
- Required docstrings are present and meaningful.
- Logging and error handling are actionable.
- Applicable verification is complete.
- `npm run check` passes before completion is reported unless an explicit blocker is documented.

## Commit Policy

- Use Conventional Commits format: `type(scope): subject`.
- Allowed types: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `build`, `ci`.
- Keep commits atomic and cohesive.
- Breaking changes should be clearly labeled.

## Cube Definition

A SugarCube (stored as `.cube`) is a serialized, validated ComfyUI subgraph with stable node identifiers, explicit input and output bindings, and embedded node definitions. It captures the runnable portion of a workflow so it can be exported, exchanged, and rehydrated without relying on the original numeric node IDs or live ComfyUI schemas.
