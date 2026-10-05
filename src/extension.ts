import * as vscode from 'vscode';
import * as path from 'path';
import { CompareProvider, TreeNode } from './compareProvider';
import { CommitsProvider, CommitTreeNode } from './commitsProvider';
import { GitContentProvider } from './contentProvider';
import { ChangeDecorationProvider } from './decorations';
import { ComparePanel } from './comparePanel';
import {
  ChangedFile,
  Commit,
  commitFiles,
  EMPTY_TREE,
  findRepoRoot,
  GitError,
  listBranches,
  rangeFiles,
} from './git';

const HAS_COMPARISON = 'branchCompare.hasComparison';
const TREE_LAYOUT = 'branchCompare.treeLayout';
const LAST_COMPARISON_KEY = 'branchCompare.lastComparison';
const TREE_LAYOUT_KEY = 'branchCompare.treeLayout';

/** What we persist in workspaceState to restore the comparison after reload. */
interface SavedComparison {
  repo: string;
  target: string;
  source: string;
  threeDot: boolean;
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new CompareProvider();
  const commitsProvider = new CommitsProvider();
  const contentProvider = new GitContentProvider();

  const treeView = vscode.window.createTreeView('branchCompare.changes', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const commitsView = vscode.window.createTreeView('branchCompare.commits', {
    treeDataProvider: commitsProvider,
    showCollapseAll: true,
    canSelectMany: true,
  });

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  statusBar.command = 'branchCompare.selectBranches';

  const syncUi = () => {
    const cmp = provider.current;
    vscode.commands.executeCommand('setContext', HAS_COMPARISON, !!cmp);
    // Remember the comparison so it survives a window reload.
    context.workspaceState.update(
      LAST_COMPARISON_KEY,
      cmp
        ? ({
            repo: cmp.repo,
            target: cmp.target,
            source: cmp.source,
            threeDot: cmp.threeDot,
          } satisfies SavedComparison)
        : undefined
    );
    if (!cmp) {
      treeView.description = undefined;
      treeView.message = undefined;
      commitsView.description = undefined;
      commitsView.message = undefined;
      statusBar.hide();
      return;
    }
    const mode = cmp.threeDot ? 'merge-base' : 'direct';
    const scope = provider.scope;
    treeView.description = scope
      ? `${scope.oldestShort} → ${scope.newestShort}`
      : `${cmp.target} ↔ ${cmp.source}`;
    treeView.message = scope
      ? `Selected commits ${scope.oldestShort} → ${scope.newestShort} (${scope.count}) · ` +
        `${scope.stat.filesChanged} file(s) · +${scope.stat.insertions} −${scope.stat.deletions} · ` +
        `clear the selection (Esc) to show the full comparison`
      : cmp.files.length === 0
        ? 'No changes between these branches.'
        : `${cmp.stat.filesChanged || cmp.files.length} file(s) changed · ` +
          `+${cmp.stat.insertions} −${cmp.stat.deletions} · ${mode}`;
    commitsView.description = `${cmp.target} ↔ ${cmp.source}`;
    commitsView.message =
      commitsProvider.count === 0
        ? `No commits on "${cmp.source}" that aren't already in "${cmp.target}".`
        : commitsProvider.truncated
          ? `Showing the latest ${commitsProvider.count} commits (branchCompare.maxCommits)`
          : `${commitsProvider.count} commit(s)`;
    statusBar.text = `$(git-compare) ${cmp.target} ↔ ${cmp.source}`;
    statusBar.tooltip = `Branch Compare · +${cmp.stat.insertions} −${cmp.stat.deletions} (${mode} diff)\nClick to change branches`;
    statusBar.show();
  };

  // Keep the Commits view pointed at whatever the Changes view is comparing.
  const syncCommits = () => {
    const cmp = provider.current;
    return commitsProvider.setScope(
      cmp ? { repo: cmp.repo, target: cmp.target, source: cmp.source } : undefined
    );
  };

  /**
   * Narrow the Changes view to the commits selected in the Commits view
   * (2+ rows), or restore the full comparison when the selection shrinks.
   */
  let selectionGen = 0;
  const applyCommitSelection = async (nodes: readonly CommitTreeNode[]) => {
    const gen = ++selectionGen;
    const cmp = provider.current;
    if (!cmp) {
      return;
    }
    const commits = nodes
      .filter((n): n is CommitTreeNode & { kind: 'commit' } => n?.kind === 'commit')
      .map((n) => n.commit);
    if (commits.length < 2) {
      provider.setScope(undefined);
      syncUi();
      return;
    }
    // Order by position in the listed history (0 = newest) and diff the whole
    // span — from the oldest selection's parent to the newest tip.
    const ordered = [...commits].sort(
      (a, b) => commitsProvider.orderOf(a.sha) - commitsProvider.orderOf(b.sha)
    );
    const newest = ordered[0];
    const oldest = ordered[ordered.length - 1];
    const span =
      commitsProvider.orderOf(oldest.sha) - commitsProvider.orderOf(newest.sha) + 1;
    const base = oldest.parents[0] ?? EMPTY_TREE;
    const files = await rangeFiles(cmp.repo, base, newest.sha);
    if (gen !== selectionGen) {
      return; // a newer selection superseded this one while git ran
    }
    provider.setScope({
      baseRef: base,
      headRef: newest.sha,
      oldestShort: oldest.shortSha,
      newestShort: newest.shortSha,
      count: span,
      files,
    });
    syncUi();
  };

  // Debounce selection churn (ctrl-clicking rows fires an event per click).
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  commitsView.onDidChangeSelection(
    () => {
      if (selectionTimer) {
        clearTimeout(selectionTimer);
      }
      selectionTimer = setTimeout(
        () => run(() => applyCommitSelection(commitsView.selection)),
        200
      );
    },
    undefined,
    context.subscriptions
  );

  const setLayout = (tree: boolean) => {
    provider.setLayout(tree);
    vscode.commands.executeCommand('setContext', TREE_LAYOUT, tree);
    context.workspaceState.update(TREE_LAYOUT_KEY, tree);
  };

  /** Open the GitLab-style compare page (repo + branch pickers + Compare). */
  const openComparePage = async () => {
    const roots = await listRepoRoots();
    if (roots.length === 0) {
      vscode.window.showWarningMessage(
        'Branch Compare: open a folder that is a git repository first.'
      );
      return;
    }
    const cfg = vscode.workspace.getConfiguration('branchCompare');
    const includeRemote = cfg.get<boolean>('showRemoteBranches', true);
    const threeDotDefault =
      provider.current?.threeDot ??
      cfg.get<string>('compareMode', 'merge-base') === 'merge-base';

    // Prefer the repo of the active comparison, else the first repo found.
    const cur = provider.current;
    const repo = cur && roots.includes(cur.repo) ? cur.repo : roots[0];
    // Open the page right away; it requests the branch list itself, which can
    // take a while in repos with thousands of branches.
    const source = cur?.repo === repo ? cur.source : undefined;
    const target = cur?.repo === repo ? cur.target : undefined;

    ComparePanel.show(
      roots.map((r) => ({ path: r, name: path.basename(r) })),
      { repo, source, target, threeDot: threeDotDefault },
      {
        loadBranches: (r) => listBranches(r, includeRemote),
        submit: async (req) => {
          try {
            contentProvider.clearCache();
            await vscode.window.withProgress(
              { location: { viewId: 'branchCompare.changes' } },
              () =>
                provider.setComparison(
                  req.repo,
                  req.target,
                  req.source,
                  req.threeDot
                )
            );
            await syncCommits();
            syncUi();
            return { ok: true };
          } catch (err) {
            return { ok: false, error: errorText(err) };
          }
        },
      }
    );
  };

  context.subscriptions.push(
    treeView,
    commitsView,
    statusBar,
    vscode.workspace.registerTextDocumentContentProvider(
      GitContentProvider.scheme,
      contentProvider
    ),
    vscode.window.registerFileDecorationProvider(new ChangeDecorationProvider()),

    vscode.commands.registerCommand('branchCompare.selectBranches', () =>
      run(() => openComparePage())
    ),
    vscode.commands.registerCommand('branchCompare.refresh', () =>
      run(async () => {
        contentProvider.clearCache();
        await provider.refresh();
        await syncCommits();
      }).then(syncUi)
    ),
    vscode.commands.registerCommand('branchCompare.swapBranches', () =>
      run(async () => {
        contentProvider.clearCache();
        await provider.swap();
        await syncCommits();
      }).then(syncUi)
    ),
    vscode.commands.registerCommand('branchCompare.toggleCompareMode', () =>
      run(async () => {
        contentProvider.clearCache();
        await provider.toggleMode();
        await syncCommits();
      }).then(syncUi)
    ),
    vscode.commands.registerCommand('branchCompare.viewAsList', () =>
      setLayout(false)
    ),
    vscode.commands.registerCommand('branchCompare.viewAsTree', () =>
      setLayout(true)
    ),
    vscode.commands.registerCommand(
      'branchCompare.openFile',
      (node: TreeNode | CommitTreeNode) => run(() => openWorkingFile(node, provider))
    ),
    vscode.commands.registerCommand(
      'branchCompare.copyPath',
      (node: TreeNode | CommitTreeNode) => run(() => copyPath(node))
    ),
    vscode.commands.registerCommand('branchCompare.openChange', (node: TreeNode) =>
      run(() => openChange(node, provider))
    ),
    vscode.commands.registerCommand('branchCompare.openAllChanges', () =>
      run(() => openAllChanges(provider))
    ),
    vscode.commands.registerCommand(
      'branchCompare.openCommitChange',
      (node: CommitTreeNode) => run(() => openCommitChange(node, provider))
    ),
    vscode.commands.registerCommand(
      'branchCompare.openCommitDiff',
      (node: CommitTreeNode, nodes?: CommitTreeNode[]) =>
        run(() =>
          openCommitDiff(
            node,
            nodes ?? [...commitsView.selection],
            provider,
            commitsProvider
          )
        )
    ),
    vscode.commands.registerCommand(
      'branchCompare.copyCommitSha',
      (node: CommitTreeNode) => run(() => copyCommitSha(node))
    )
  );

  vscode.commands.executeCommand('setContext', HAS_COMPARISON, false);
  setLayout(context.workspaceState.get<boolean>(TREE_LAYOUT_KEY, true));

  // Restore the previous comparison (if any) without blocking activation.
  // Silently drop it when it no longer applies (repo gone, branch deleted).
  const saved = context.workspaceState.get<SavedComparison>(LAST_COMPARISON_KEY);
  if (saved) {
    (async () => {
      try {
        await provider.setComparison(
          saved.repo,
          saved.target,
          saved.source,
          saved.threeDot
        );
        await syncCommits();
      } catch {
        provider.clear();
        commitsProvider.clear();
      }
      syncUi();
    })();
  }
}

export function deactivate() {}

/** Turn any thrown error into a human-friendly message. */
function errorText(err: unknown): string {
  return err instanceof GitError
    ? err.stderr.trim() || err.message
    : err instanceof Error
      ? err.message
      : String(err);
}

/** Run an async action, surfacing git/other errors as notifications. */
async function run(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (err) {
    vscode.window.showErrorMessage(`Branch Compare: ${errorText(err)}`);
  }
}

/** Distinct git repository roots across all workspace folders. */
async function listRepoRoots(): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const roots = new Set<string>();
  for (const folder of folders) {
    const root = await findRepoRoot(folder.uri.fsPath);
    if (root) {
      roots.add(root);
    }
  }
  return [...roots];
}

async function openChange(node: TreeNode, provider: CompareProvider): Promise<void> {
  const cmp = provider.current;
  if (!cmp || !node || node.kind !== 'file') {
    return;
  }
  const f = node.file;
  const leftPath = f.oldPath ?? f.path;

  // When the view is narrowed to selected commits, diff within that range.
  const scope = provider.scope;
  const leftRef = scope ? scope.baseRef : cmp.baseRef;
  const rightRef = scope ? scope.headRef : cmp.source;

  const left = GitContentProvider.toUri({
    repo: cmp.repo,
    ref: leftRef,
    relPath: leftPath,
  });
  const right = GitContentProvider.toUri({
    repo: cmp.repo,
    ref: rightRef,
    relPath: f.path,
  });

  const name = path.posix.basename(f.path);
  const label = scope
    ? `${scope.oldestShort} → ${scope.newestShort}`
    : `${cmp.target} ↔ ${cmp.source}`;
  const title =
    (f.status === 'R' || f.status === 'C') && f.oldPath
      ? `${path.posix.basename(f.oldPath)} → ${name} (${label})`
      : `${name} (${label})`;

  await vscode.commands.executeCommand('vscode.diff', left, right, title, {
    preview: true,
  });
}

async function openCommitChange(
  node: CommitTreeNode,
  provider: CompareProvider
): Promise<void> {
  const cmp = provider.current;
  if (!cmp || !node || node.kind !== 'commitFile') {
    return;
  }
  const { commit, file } = node;
  // Diff the commit against its first parent (or the empty tree for a root).
  const parentRef = commit.parents[0] ?? EMPTY_TREE;
  const leftPath = file.oldPath ?? file.path;

  const left = GitContentProvider.toUri({
    repo: cmp.repo,
    ref: parentRef,
    relPath: leftPath,
  });
  const right = GitContentProvider.toUri({
    repo: cmp.repo,
    ref: commit.sha,
    relPath: file.path,
  });

  const name = path.posix.basename(file.path);
  const title =
    (file.status === 'R' || file.status === 'C') && file.oldPath
      ? `${path.posix.basename(file.oldPath)} → ${name} (${commit.shortSha})`
      : `${name} (${commit.shortSha})`;

  await vscode.commands.executeCommand('vscode.diff', left, right, title, {
    preview: true,
  });
}

async function openAllChanges(provider: CompareProvider): Promise<void> {
  const cmp = provider.current;
  if (!cmp) {
    return;
  }
  const scope = provider.scope;
  const files = scope ? scope.files : cmp.files;
  if (files.length === 0) {
    vscode.window.showInformationMessage('Branch Compare: no changes to show.');
    return;
  }
  const leftRef = scope ? scope.baseRef : cmp.baseRef;
  const rightRef = scope ? scope.headRef : cmp.source;
  const resources = files.map((f) => diffTuple(cmp.repo, leftRef, rightRef, f));
  const label = scope
    ? `commits ${scope.oldestShort} → ${scope.newestShort}`
    : `${cmp.target} ↔ ${cmp.source}`;
  await openMultiDiff(`Changes: ${label}`, resources);
}

async function openCommitDiff(
  node: CommitTreeNode,
  selection: CommitTreeNode[],
  provider: CompareProvider,
  commitsProvider: CommitsProvider
): Promise<void> {
  const cmp = provider.current;
  if (!cmp) {
    return;
  }
  // Use the multi-selection only when it includes the clicked commit;
  // otherwise the action applies to just the row that was invoked.
  const selected = selection.filter(
    (n): n is CommitTreeNode & { kind: 'commit' } => n?.kind === 'commit'
  );
  const commits: Commit[] =
    node?.kind === 'commit' &&
    !selected.some((n) => n.commit.sha === node.commit.sha)
      ? [node.commit]
      : selected.map((n) => n.commit);
  if (commits.length === 0) {
    return;
  }

  if (commits.length === 1) {
    const commit = commits[0];
    const files = await commitFiles(cmp.repo, commit.sha);
    if (files.length === 0) {
      vscode.window.showInformationMessage(
        `Branch Compare: ${commit.shortSha} changed no files.`
      );
      return;
    }
    const parentRef = commit.parents[0] ?? EMPTY_TREE;
    const resources = files.map((f) =>
      diffTuple(cmp.repo, parentRef, commit.sha, f)
    );
    const subject = commit.subject ? ` · ${commit.subject}` : '';
    await openMultiDiff(`Commit ${commit.shortSha}${subject}`, resources);
    return;
  }

  // Several commits: show everything from the oldest one's parent up to the
  // newest tip. Order by position in the listed history (0 = newest).
  const ordered = [...commits].sort(
    (a, b) => commitsProvider.orderOf(a.sha) - commitsProvider.orderOf(b.sha)
  );
  const newest = ordered[0];
  const oldest = ordered[ordered.length - 1];
  const span =
    commitsProvider.orderOf(oldest.sha) - commitsProvider.orderOf(newest.sha) + 1;
  if (span > commits.length) {
    vscode.window.showInformationMessage(
      `Branch Compare: selection isn't contiguous — showing all changes from ` +
        `${oldest.shortSha} to ${newest.shortSha}, including the ` +
        `${span - commits.length} commit(s) in between.`
    );
  }
  const base = oldest.parents[0] ?? EMPTY_TREE;
  const files = await rangeFiles(cmp.repo, base, newest.sha);
  if (files.length === 0) {
    vscode.window.showInformationMessage(
      `Branch Compare: no changes between ${oldest.shortSha} and ${newest.shortSha}.`
    );
    return;
  }
  const resources = files.map((f) => diffTuple(cmp.repo, base, newest.sha, f));
  await openMultiDiff(
    `Commits ${oldest.shortSha} → ${newest.shortSha} (${span})`,
    resources
  );
}

/** Build a [resource, original, modified] URI tuple for one changed file. */
function diffTuple(
  repo: string,
  leftRef: string,
  rightRef: string,
  f: ChangedFile
): [vscode.Uri, vscode.Uri, vscode.Uri] {
  const leftPath = f.oldPath ?? f.path;
  const left = GitContentProvider.toUri({ repo, ref: leftRef, relPath: leftPath });
  const right = GitContentProvider.toUri({ repo, ref: rightRef, relPath: f.path });
  // First URI is the row identity/label; use the modified side (carries path).
  return [right, left, right];
}

/**
 * Open a set of file diffs in VS Code's multi-file (scrolling) diff editor.
 * Prefers the public `vscode.changes` command; falls back to the internal
 * multi-diff command for older/edge builds.
 */
async function openMultiDiff(
  title: string,
  resources: [vscode.Uri, vscode.Uri, vscode.Uri][]
): Promise<void> {
  try {
    await vscode.commands.executeCommand('vscode.changes', title, resources);
  } catch {
    const sourceUri = vscode.Uri.from({
      scheme: 'branch-compare-multi',
      path: '/' + encodeURIComponent(title),
    });
    await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
      title,
      multiDiffSourceUri: sourceUri,
      resources: resources.map(([, original, modified]) => ({
        originalUri: original,
        modifiedUri: modified,
      })),
    });
  }
}

/** Pull the ChangedFile out of either tree's file node. */
function fileOf(node: TreeNode | CommitTreeNode): ChangedFile | undefined {
  if (!node) {
    return undefined;
  }
  if (node.kind === 'file' || node.kind === 'commitFile') {
    return node.file;
  }
  return undefined;
}

/** Open the working-tree copy of a changed file in a normal editor. */
async function openWorkingFile(
  node: TreeNode | CommitTreeNode,
  provider: CompareProvider
): Promise<void> {
  const cmp = provider.current;
  const file = fileOf(node);
  if (!cmp || !file) {
    return;
  }
  const uri = vscode.Uri.file(path.join(cmp.repo, file.path));
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    vscode.window.showInformationMessage(
      `Branch Compare: "${file.path}" does not exist in the working tree.`
    );
    return;
  }
  await vscode.window.showTextDocument(uri, { preview: true });
}

async function copyPath(node: TreeNode | CommitTreeNode): Promise<void> {
  const file = fileOf(node);
  if (!file) {
    return;
  }
  await vscode.env.clipboard.writeText(file.path);
  vscode.window.setStatusBarMessage(`Copied ${file.path} to clipboard`, 2000);
}

async function copyCommitSha(node: CommitTreeNode): Promise<void> {
  if (!node || node.kind !== 'commit') {
    return;
  }
  await vscode.env.clipboard.writeText(node.commit.sha);
  vscode.window.setStatusBarMessage(
    `Copied ${node.commit.shortSha} to clipboard`,
    2000
  );
}
