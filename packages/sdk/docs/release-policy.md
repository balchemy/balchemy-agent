# SDK Release Policy (SemVer)

## Versioning

- `MAJOR`: breaking API changes.
- `MINOR`: backward-compatible feature additions.
- `PATCH`: bug fixes and internal improvements.

## Stability Levels

- `0.x`: fast iteration, possible interface churn.
- `1.x`: stable public API contract.

## Publish Gates

1. Typecheck passes.
2. Onboarding smoke examples updated.
3. Changelog entry added.
4. Backward compatibility review complete for public exports.

## Deprecation Rule

- Add deprecation notice in docs before removal.
- Keep deprecated APIs for at least one minor release when possible.
