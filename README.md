# Branch Compare

Compare two git branches visually — a **merge-request-style** review right
inside VS Code, without needing an actual MR/PR. Pick any two branches, get a
tree of changed files, browse the commits, and click any file to open VS Code's
built-in side-by-side diff.

## Install

Install **Git Branch Compare** from the Visual Studio Marketplace:

- In VS Code, open the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`),
  search for **Git Branch Compare**, and click **Install**.
- Or from the command line:

  ```bash
  code --install-extension tofilagman.git-branch-compare
  ```

- Or open it directly on the
  [Marketplace](https://marketplace.visualstudio.com/items?itemName=tofilagman.git-branch-compare).

## Features

- **Branch → branch comparison** from a dedicated activity-bar view.
- **GitLab-style compare page** — pick the target and source branches from
  **searchable dropdowns** (type to filter, built to handle thousands of
  branches), choose the diff mode, and hit **Compare**.
- **Merge-base (three-dot) diff by default** — shows only the changes introduced
  on the *source* branch since it diverged from the *target*, the same way a
  merge request presents changes. Toggle to a **direct (two-dot)** diff any time.
- **File tree** with git-style `A`/`M`/`D`/`R` badges and colors, compacted
  folders, per-file `+/−` line counts in tooltips, and a `+/−` summary for the
  whole comparison. Switch between **tree and flat-list layout** from the view
  title.
- **Commits view** listing the commits on the source branch that aren't in the
  target (`target..source`) — like an MR's Commits tab. Expand a commit to
  see its changed files, and click a file to diff that commit against its
  parent. Copy a commit's SHA from its inline action.
- **View entire commit as one diff** — the inline action on a commit opens all
  of its files together in VS Code's scrolling multi-file diff editor. The
  Changes view title has the same **View all changes as one diff** action for
  the whole comparison.
- **Native diff editor** on click — full syntax highlighting, folding, and
  inline navigation for free. Added/deleted files render correctly.
- **Swap** target/source and **refresh** after new commits, from the view title.
- **Open the working-tree file** or **copy its relative path** from a changed
  file's context menu.
- **Comparison persists across window reloads** — reopen VS Code and pick up
  the review where you left off.
- Binary files are detected and shown as a short note instead of raw bytes.
- Works with local and remote-tracking branches.

## Usage

1. Open the **Branch Compare** view in the activity bar.
2. Click **Open compare page**.
3. On the page, pick the **target** (base) and **source** (changes) branches
   from the searchable dropdowns — type to filter, handy when a repo has
   thousands of branches — choose the diff mode, and click **Compare**.
4. Browse the changed files and click any file to open its diff.

Use the view-title buttons to swap branches, toggle merge-base/direct mode, or
refresh.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `branchCompare.compareMode` | `merge-base` | `merge-base` (three-dot, MR-style) or `direct` (two-dot). |
| `branchCompare.showRemoteBranches` | `true` | Include remote-tracking branches in the picker. |
| `branchCompare.maxCommits` | `500` | Cap on the Commits view list (`0` = unlimited). |

## Develop

```bash
npm install
npm run compile      # or: npm run watch
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with the
extension loaded. Requires `git` on your `PATH`.

## How it works

The changed-file list comes from `git diff --name-status` plus `--numstat` over
the chosen range (`target...source` for merge-base, `target..source` for
direct), run in parallel and merged. Each file's two sides are served to the
diff editor by a virtual `branch-compare:` document provider backed by
`git show <ref>:<path>` (with in-memory caching per comparison), so nothing is
written to disk and your working tree is never touched.

## License

MIT
