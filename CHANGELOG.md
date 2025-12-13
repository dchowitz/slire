# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2025-12-13
### Breaking
- MongoDB helper rename: `applyConstraints` has been renamed to `applyFilter` on `MongoRepo`. Update any direct `repo.applyConstraints(...)` usages to `repo.applyFilter(...)`.
- Stricter filter typing and validation: `Filter<T>` and the runtime validator now only accept scalar values on leaf fields (including dot-paths like `'metadata.assigneeId'`). Passing nested objects/arrays (for example `{ metadata: { foo: 'bar' } }`) is now rejected by types and/or at runtime; this may surface previously-silent bugs.
- Stricter `options` typing on repo factories: `createMongoRepo` / `createFirestoreRepo` now expose a strongly-typed `options` parameter matching the repo config. Mis-typed or unknown config keys that previously compiled may now fail type-checking.

### Changed
- Docs: clarify filter semantics, helper naming, and configuration options.

## [0.0.6] - 2025-12-07
### Changed
- Docs: DESIGN — overhaul, better examples

## [0.0.5] - 2025-12-02
### Chore
- Release bump for testing publish workflow (no functional changes)

## [0.0.4] - 2025-12-02
### Chore
- Release bump for testing publish workflow (no functional changes)

## [0.0.3] - 2025-11-30
### Changed
- Chore: regenerate `package-lock.json`.
- Tests: fix fixtures (don't assume colima).
- Docs: WHY — fix links, misc improvements.
- Docs: AUDIT — better examples, pluggable event emitter approach.

## [0.0.2] - 2025-11-23
### Changed
- Docs: README — install notes for peer deps; FAQ and examples polished.
- Docs: WHY — clarified rationale with concrete references; tightened language.

## [0.0.1] - 2025-11-22
### Added
- Initial public version.

<!-- Links -->
[Unreleased]: https://github.com/dchowitz/slire/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/dchowitz/slire/compare/v0.0.6...v1.0.0
[0.0.6]: https://github.com/dchowitz/slire/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/dchowitz/slire/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/dchowitz/slire/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/dchowitz/slire/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/dchowitz/slire/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/dchowitz/slire/releases/tag/v0.0.1
