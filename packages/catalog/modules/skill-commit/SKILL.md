---
name: commit
description: Title-only git commit policy. Use before running `git commit` or writing any commit message; enforces one Conventional Commit title line with no body and no trailers.
---

# Commit: title only

Every commit message is exactly one line: the title.

## Rules

1. One line. No body, no blank line, no bullet list.
2. No trailers: never add `Co-Authored-By:`, `Signed-off-by:`, "Generated with" lines, or any AI attribution.
3. Use a single `-m` flag: `git commit -m "<title>"`. No heredocs, `-F`, or editor.
4. Follow the repository's existing convention (`git log --oneline -n 10`). Otherwise use Conventional Commits: `type(scope): summary`, imperative mood, lowercase, no trailing period, ideally 72 characters or fewer.
5. Details belong in the pull request description, not the commit.

## Procedure

1. Inspect the change with `git status` and `git diff --staged`.
2. Stage only the intended files.
3. Commit with one title line.
4. Verify with `git log -1 --format=%B` that the message is a single line.
