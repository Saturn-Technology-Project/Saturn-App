---
name: research-bundles
description: Take a project's research evidence to another project as a verified bundle, or bring one in. Read when the person wants to share, archive or move evidence.
---
# Research bundles

A bundle carries evidence, not the ability to compute: records, samples, labels, metrics, logs, inspection readings, saved source objects and analysis snapshots, with escaped Markdown and HTML reports.

## Export
`research_evidence` with `action: "bundle_export"` and an optional `path` inside the project (the default is under `exports/`). It refuses to overwrite a file. The reports beside the bundle list what is external or missing (weights, datasets, scorers, environments) rather than copying or reconstructing it. Settings, permissions and credentials are never in it.

## Import
1. The bundle must already be inside the project. `research_read` with `what: "bundle_preview"`, `path`: what it holds, what is identical to what is here, and what would conflict. Nothing is written.
2. `research_evidence` with `action: "bundle_import"`, `path`. Every file's size and hash is checked; conflicting contents are refused rather than overwritten.

## What came in
- Imported versions and inspection sessions are read-only archives. Their commands and interpreters never run, and their remote jobs never reconnect. To compute again, freeze a new local version or open a new inspection session.
- Labels and verdicts in a bundle are the original people's. Do not treat them as yours, and do not change them.
- Hashes detect corruption, not authorship. Say where a bundle came from when you rely on it.
