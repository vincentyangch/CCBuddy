# CCBuddy Local Skills and Runtime State Design

**Date:** 2026-04-08
**Status:** Draft
**Author:** flyingchickens + Codex

## 1. Overview

CCBuddy currently mixes two different classes of data inside the tracked `skills/` area:

1. Canonical project skills that should be versioned in git
2. Machine-local runtime state that should not dirty the repository during normal use

The current behavior causes the repo to become dirty during ordinary skill execution because runtime metadata is persisted into tracked files. The most visible example is `skills/registry.yaml`, which accumulates mutable values such as usage counts, last-used timestamps, and machine-specific resolved paths.

This design separates tracked skill definitions from local skill state so that:

- normal runtime usage does not modify tracked files
- local-only skills remain local
- promoted skills can intentionally become tracked project assets
- canonical project skills remain stable and reviewable in git

## 2. Goals

1. Keep bundled and promoted project skills in tracked locations.
2. Keep local-only skills in a gitignored location inside the repo.
3. Keep runtime metadata local-only.
4. Prevent machine-specific absolute paths from being written into tracked files.
5. Provide an explicit promotion flow from local skill to tracked project skill.
6. Preserve good operator ergonomics: local skills should still be easy to inspect and edit.

## 3. Non-Goals

1. This design does not change the skill execution model itself.
2. This design does not redesign skill permissions or approval behavior.
3. This design does not move local skills outside the repo.
4. This design does not add automatic promotion. Promotion remains explicit.
5. This design does not attempt to make local skills shadow tracked skills.

## 4. Current Problem

Today, the tracked registry is acting as both:

- a source of truth for project skills
- a runtime database for local execution metadata

That creates three concrete problems:

1. Normal skill execution dirties the worktree.
2. Tracked files can contain machine-local absolute paths.
3. The boundary between local experimentation and project-owned skills is unclear.

This is an architectural mismatch, not just a formatting issue. A tracked registry cannot also serve as a per-machine mutable state store without causing ongoing repository churn.

## 5. Proposed Model

CCBuddy will use a dual-layer skill system.

### 5.1 Tracked Layer

The tracked layer contains skills that are part of the project itself.

- `skills/bundled/`
  - Built-in, curated skills that ship with the repo
- `skills/generated/`
  - Project skills that were promoted from local development and are now intentionally tracked
- tracked registry
  - Contains only stable tracked skill definitions needed to load bundled and promoted project skills

The tracked registry must not store runtime usage counters, last-used timestamps, or machine-specific resolved paths.

### 5.2 Local Layer

The local layer contains skills and metadata that belong only to the current machine or working copy.

- `skills/local/`
  - Local-only skills
- `skills/local/registry.yaml`
  - Local-only registry and runtime metadata store

This path must be gitignored.

The local registry stores:

- local skill definitions or local skill indexing metadata
- runtime metadata such as `usageCount`
- `lastUsed`
- any machine-local resolved path data if path caching is needed

The local registry must not be treated as a canonical project artifact.

## 6. Directory Layout

After the change, the intended layout is:

```text
skills/
  bundled/              # tracked built-in skills
  generated/            # tracked promoted project skills
  local/                # gitignored local-only skills
    registry.yaml       # gitignored local metadata / local index
  registry.yaml         # tracked stable registry for bundled + generated skills
```

Git behavior:

- `skills/local/` is gitignored
- `skills/registry.yaml` remains tracked
- tracked files under `skills/bundled/` and `skills/generated/` remain versioned normally

## 7. Registry Responsibilities

### 7.1 Tracked Registry

The tracked registry is responsible for stable project skill loading only.

It may contain:

- skill name
- description
- version
- source
- repo-relative file location
- input schema
- permissions
- enabled state

It must not contain:

- `usageCount`
- `lastUsed`
- machine-local absolute paths
- ephemeral timestamps from normal execution
- any metadata that changes merely because a skill was run

### 7.2 Local Registry

The local registry is responsible for local-only skill and runtime state persistence.

It may contain:

- local skill records
- usage counters
- last-used timestamps
- local updated-at values
- machine-local resolved paths if needed

If local metadata changes during execution, only the local registry may be written.

## 8. Skill Loading Rules

Startup loading order:

1. Load tracked skills from the tracked registry.
2. Load local skills from `skills/local/registry.yaml` or treat the local layer as empty if absent.

Collision rule:

- if a local skill name matches a tracked skill name, the tracked skill wins
- the local conflicting skill is ignored
- the collision is logged clearly for the operator

This prevents local experiments from silently overriding canonical project behavior.

## 9. Path Handling

Tracked skill records must not persist machine-specific absolute paths into tracked files.

Preferred rule:

- tracked skill locations are stored in a stable repo-relative form, or are derived deterministically from their known directory
- local path resolution happens at runtime

Local-only state may store machine-local resolved paths if doing so materially simplifies execution, because those files are gitignored.

The key rule is that tracked state must be portable across machines and clones.

## 10. Local Skill Creation

New user-created skills default to local skills.

Creation behavior:

- a newly created skill is written into `skills/local/`
- its metadata is written into the local registry
- no tracked registry file is modified merely because a local skill was created

This keeps personal experimentation local by default.

## 11. Promotion Flow

Promotion is explicit.

When a local skill is promoted:

1. Validate the local skill again before promotion.
2. Ensure no tracked skill with the same name already exists.
3. Move the skill from `skills/local/` to `skills/generated/`.
4. Add or update the tracked registry entry for the promoted skill.
5. Remove the local copy and local registry entry.
6. Drop runtime-only local metadata such as `usageCount` and `lastUsed` rather than carrying it into tracked state.

Promotion target:

- promoted skills land in `skills/generated/`
- `skills/bundled/` remains reserved for built-in or explicitly curated system-grade skills

Rationale:

- `generated/` is the correct place for user-created skills that have been adopted into the project
- `bundled/` should not become a catch-all for promoted local work

## 12. Failure Behavior

### 12.1 Missing Local Registry

If `skills/local/registry.yaml` does not exist:

- treat the local layer as empty and create the file lazily on first local write
- startup must still succeed

### 12.2 Malformed Local Registry

If the local registry is malformed:

- tracked skills must still load
- local skill loading should degrade gracefully
- the system should skip invalid local entries and report the issue

### 12.3 Name Collision on Promotion

If promotion targets a name that already exists in tracked skills:

- fail promotion safely
- leave the local source skill intact
- do not partially update tracked state

### 12.4 Write Failure During Promotion

If any write fails during promotion:

- do not delete the local source until the tracked destination is confirmed
- avoid partial state where the skill disappears from both places
- prefer transactional sequencing or rollback behavior

## 13. Migration Plan

Migration must normalize existing skill storage into the new model.

### 13.1 Tracked Registry Cleanup

Normalize `skills/registry.yaml` so it contains only stable tracked skill data.

Remove from tracked state:

- runtime usage counters
- last-used timestamps
- execution-driven updated-at values
- machine-specific absolute path entries

### 13.2 Existing Generated Skills

Existing skills under `skills/generated/` need a deliberate classification:

- if they are intended to be project-owned skills, keep them in `skills/generated/`
- if they are intended to be machine-local skills, move them into `skills/local/`

This classification should be explicit rather than inferred from current location alone.

### 13.3 Runtime Metadata Reset

Runtime metadata currently stored in tracked registry entries will not be preserved as tracked history.

During migration, existing tracked runtime metadata will be discarded rather than copied forward into the new local registry.

The important rule is that the tracked registry stops carrying runtime state entirely.

## 14. Testing Strategy

The implementation must add tests for the following:

1. Running tracked skills does not modify tracked registry files.
2. Running local skills updates only local metadata.
3. Startup works when `skills/local/registry.yaml` is missing.
4. Malformed local registry data does not break tracked skill loading.
5. Tracked skills win when local and tracked names collide.
6. Promotion moves a local skill into `skills/generated/`.
7. Promotion removes the local source after successful move.
8. Promotion fails safely on name collision.
9. Tracked registry does not persist absolute machine-local paths.
10. Local runtime metadata does not leak into tracked files.

## 15. Operational Notes

This design intentionally favors repository cleanliness over trying to preserve every execution metric in a tracked file.

The practical effect should be:

- normal use does not dirty the repo
- local skills remain easy to inspect because they live in-repo
- promotion is deliberate and reviewable
- tracked project skills remain portable and stable

## 16. Recommendation

Implement the dual-layer model exactly as described:

- tracked canonical skills in `bundled/` and `generated/`
- gitignored local skills in `skills/local/`
- gitignored local registry for runtime and local-only state
- explicit move-based promotion into `skills/generated/`
- tracked registry stripped down to stable project-owned data only

This directly addresses the dirty-worktree problem without weakening the local-skill workflow.
