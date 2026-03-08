# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-03-08

### Added
- 6-day source rotation selector (`15/15/15/15/15/17`) via `scripts/select-sources-rotation.mjs`.
- Local Ollama pre-compression stage via `scripts/compress-with-ollama.mjs`.
- Strict hard pipeline runner `scripts/run-digest-hard.sh`.
- MIT `LICENSE` file with fork continuity notice.
- Fork/license/change summary in `README.md`.

### Changed
- Updated `SKILL.md` workflow to use rotation + local compression before main-model writing.
- Updated digest flow to use compact JSON as primary input.
- Updated `.gitignore` to exclude runtime outputs and state files.

### Notes
- Forked from `HarrisHan/ai-daily-digest` and continues under MIT terms.
