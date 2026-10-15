## Summary

<!-- Explain the motivation and the focused change. -->

## Related issue

<!-- Use "Closes #123" when applicable. -->

## Verification

<!-- List automated checks and manual scenarios you ran. -->

- [ ] `uv run python -m pytest`
- [ ] `uv run ruff check --select E4,E7,E9,F services/local_server`
- [ ] `pnpm test`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `git diff --check`

## User-visible impact

<!-- Describe behavior changes, compatibility considerations, or write "None". -->

## Screenshots

<!-- Required for popup or subtitle-overlay changes; otherwise write "Not applicable". -->

## Final checklist

- [ ] Tests cover new or changed behavior.
- [ ] No tokens, pairing data, downloaded media, or machine-specific paths are included.
- [ ] `README.md` is updated when user-facing behavior changes.
