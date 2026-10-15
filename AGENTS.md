# Repository Guidelines

## Project Structure & Module Organization

This repository combines a Python localhost service with a Chrome Manifest V3 extension. Backend code lives in `services/local_server/ytwhisper/`; its pytest suite and fixtures are in `services/local_server/tests/`. Extension sources, manifest, and build script live in `apps/extension/`, with Vitest tests under `apps/extension/tests/`. Generated extension files go to `apps/extension/dist/` and should not be edited directly.

## Build, Test, and Development Commands

Run commands from the repository root:

- `uv sync --extra dev` installs Python runtime and development dependencies.
- `pnpm install` installs workspace dependencies.
- `uv run ytwhisper serve --extension-id <ID>` starts the local API on `127.0.0.1:8765`.
- `uv run python -m pytest` runs backend tests.
- `pnpm test` runs extension tests with Vitest.
- `pnpm typecheck` checks strict TypeScript without emitting files.
- `pnpm build` builds the loadable extension into `apps/extension/dist/`.
- `uv run ruff check --select E4,E7,E9,F services/local_server` runs the required Python correctness lint. Use the broader `ruff check` command for additional style feedback.

Before submitting, also run `git diff --check`.

## Coding Style & Naming Conventions

Python targets 3.10–3.13, uses four-space indentation, a 100-character Ruff line limit, `snake_case` functions/modules, and `PascalCase` classes. TypeScript uses strict mode, two-space indentation, `camelCase` values/functions, and `PascalCase` types. Keep API contracts centralized in `apps/extension/src/contracts.ts`. Preserve the existing separation between Chrome UI/content scripts, background API orchestration, and backend media/transcription logic.

## Testing Guidelines

Add focused tests with every behavioral change. Name Python files `test_<area>.py` and TypeScript files `<area>.test.ts`. Prefer deterministic unit tests and existing fixtures; routine tests must not download Whisper models or public videos. For cross-component changes, test both the FastAPI behavior and extension handling. Manually verify user-facing playback changes with short public English and Chinese videos.

## Commit & Pull Request Guidelines

History generally follows Conventional Commit subjects such as `feat(extension): ...`, `fix: ...`, and `docs: ...`. Keep commits focused and imperative. Pull requests should explain motivation, user-visible impact, and verification performed; link relevant issues and include screenshots for popup or subtitle-overlay changes.

## Security & Configuration

Never commit pairing tokens, `pairing.json`, downloaded media, model caches, or machine-specific paths. Keep the service bound to localhost, preserve Origin and bearer-token checks, and avoid logging secrets in bug reports or test output.
