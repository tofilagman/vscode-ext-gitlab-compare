# GitLab Compare

Compare two git branches visually — like the **Changes** tab of a GitLab merge
request, but without needing an MR. Pick any two branches, get a tree of changed
files, and click any file to open VS Code's built-in side-by-side diff.

## Features

- **Branch → branch comparison** from a dedicated activity-bar view.
- **Merge-base (three-dot) diff by default** — shows only the changes introduced
  on the *source* branch since it diverged from the *target*, exactly like a
  GitLab MR. Toggle to a **direct (two-dot)** diff any time.
- **File tree** with git-style `A`/`M`/`D`/`R` badges and colors, compacted
  folders, and a `+/−` line-change summary.
- **Commits view** listing the commits on the source branch that aren't in the
  target (`target..source`) — just like an MR's Commits tab. Expand a commit to
  see its changed files, and click a file to diff that commit against its
  parent. Copy a commit's SHA from its inline action.
- **View entire commit as one diff** — the inline action on a commit opens all
  of its files together in VS Code's scrolling multi-file diff editor. The
  Changes view title has the same **View all changes as one diff** action for
  the whole comparison.
- **Native diff editor** on click — full syntax highlighting, folding, and
  inline navigation for free. Added/deleted files render correctly.
- **Swap** target/source and **refresh** after new commits, from the view title.
- Works with local and remote-tracking branches.

## Usage

1. Open the **GitLab Compare** view in the activity bar.
2. Click **Select branches to compare**.
3. Choose the **source** branch (the changes you want to review), then the
   **target** branch (the base to compare against).
4. Browse the changed files and click any file to open its diff.

Use the view-title buttons to swap branches, toggle merge-base/direct mode, or
refresh.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `gitlabCompare.compareMode` | `merge-base` | `merge-base` (three-dot, GitLab-style) or `direct` (two-dot). |
| `gitlabCompare.showRemoteBranches` | `true` | Include remote-tracking branches in the picker. |

## Develop

```bash
npm install
npm run compile      # or: npm run watch
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with the
extension loaded. Requires `git` on your `PATH`.

## How it works

The changed-file list comes from `git diff --name-status` over the chosen range
(`target...source` for merge-base, `target..source` for direct). Each file's two
sides are served to the diff editor by a virtual `gitlab-compare:` document
provider backed by `git show <ref>:<path>`, so nothing is written to disk and
your working tree is never touched.

## License

MIT
