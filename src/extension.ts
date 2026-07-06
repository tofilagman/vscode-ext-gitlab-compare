import * as vscode from 'vscode';
import * as path from 'path';
import { CompareProvider, TreeNode } from './compareProvider';
import { CommitsProvider, CommitTreeNode } from './commitsProvider';
import { GitContentProvider } from './contentProvider';
import { ChangeDecorationProvider } from './decorations';
import {
  Branch,
  ChangedFile,
  commitFiles,
  EMPTY_TREE,
  findRepoRoot,
  GitError,
  listBranches,
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
    treeView.description = `${cmp.target} ↔ ${cmp.source}`;
    treeView.message =
      cmp.files.length === 0
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

  const setLayout = (tree: boolean) => {
    provider.setLayout(tree);
    vscode.commands.executeCommand('setContext', TREE_LAYOUT, tree);
    context.workspaceState.update(TREE_LAYOUT_KEY, tree);
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
      run(async () => {
        contentProvider.clearCache();
        await selectBranches(provider);
        await syncCommits();
      }).then(syncUi)
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
      (node: CommitTreeNode) => run(() => openCommitDiff(node, provider))
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

/** Run an async action, surfacing git/other errors as notifications. */
async function run(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (err) {
    const detail =
      err instanceof GitError
        ? err.stderr.trim() || err.message
        : err instanceof Error
          ? err.message
          : String(err);
    vscode.window.showErrorMessage(`Branch Compare: ${detail}`);
  }
}

async function selectBranches(provider: CompareProvider): Promise<void> {
  const repo = await pickRepo();
  if (!repo) {
    return;
  }

  const includeRemote = vscode.workspace
    .getConfiguration('branchCompare')
    .get<boolean>('showRemoteBranches', true);
  const branches = await listBranches(repo, includeRemote);
  if (branches.length < 2) {
    vscode.window.showWarningMessage(
      'Branch Compare: need at least two branches to compare.'
    );
    return;
  }

  const current = branches.find((b) => b.current)?.name;
  const source = await pickBranch(
    branches,
    'Select the SOURCE branch — the changes you want to review',
    current
  );
  if (!source) {
    return;
  }

  const target = await pickBranch(
    branches.filter((b) => b.name !== source),
    `Select the TARGET branch to compare "${source}" against`
  );
  if (!target) {
    return;
  }

  const threeDot =
    vscode.workspace
      .getConfiguration('branchCompare')
      .get<string>('compareMode', 'merge-base') === 'merge-base';

  await vscode.window.withProgress(
    { location: { viewId: 'branchCompare.changes' } },
    () => provider.setComparison(repo, target, source, threeDot)
  );
}

function pickBranch(
  branches: Branch[],
  placeHolder: string,
  preselect?: string
): Thenable<string | undefined> {
  const items: (vscode.QuickPickItem & { name: string })[] = branches.map((b) => ({
    name: b.name,
    label: b.current ? `$(star-full) ${b.name}` : `$(git-branch) ${b.name}`,
    description: [b.current ? 'current' : '', b.remote ? 'remote' : '']
      .filter(Boolean)
      .join(' · '),
  }));
  // Float the pre-selected branch to the top for convenience.
  if (preselect) {
    const idx = items.findIndex((i) => i.name === preselect);
    if (idx > 0) {
      items.unshift(items.splice(idx, 1)[0]);
    }
  }
  return vscode.window
    .showQuickPick(items, { placeHolder, matchOnDescription: true })
    .then((pick) => pick?.name);
}

async function pickRepo(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    vscode.window.showWarningMessage(
      'Branch Compare: open a folder that is a git repository first.'
    );
    return undefined;
  }

  const roots = new Set<string>();
  for (const folder of folders) {
    const root = await findRepoRoot(folder.uri.fsPath);
    if (root) {
      roots.add(root);
    }
  }
  const list = [...roots];
  if (list.length === 0) {
    vscode.window.showWarningMessage(
      'Branch Compare: no git repository found in the workspace.'
    );
    return undefined;
  }
  if (list.length === 1) {
    return list[0];
  }
  return vscode.window.showQuickPick(
    list.map((r) => ({ label: path.basename(r), description: r, root: r })),
    { placeHolder: 'Select the repository to compare branches in' }
  ).then((pick) => (pick as { root: string } | undefined)?.root);
}

async function openChange(node: TreeNode, provider: CompareProvider): Promise<void> {
  const cmp = provider.current;
  if (!cmp || !node || node.kind !== 'file') {
    return;
  }
  const f = node.file;
  const leftPath = f.oldPath ?? f.path;

  const left = GitContentProvider.toUri({
    repo: cmp.repo,
    ref: cmp.baseRef,
    relPath: leftPath,
  });
  const right = GitContentProvider.toUri({
    repo: cmp.repo,
    ref: cmp.source,
    relPath: f.path,
  });

  const name = path.posix.basename(f.path);
  const scope = `${cmp.target} ↔ ${cmp.source}`;
  const title =
    (f.status === 'R' || f.status === 'C') && f.oldPath
      ? `${path.posix.basename(f.oldPath)} → ${name} (${scope})`
      : `${name} (${scope})`;

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
  if (cmp.files.length === 0) {
    vscode.window.showInformationMessage('Branch Compare: no changes to show.');
    return;
  }
  const resources = cmp.files.map((f) =>
    diffTuple(cmp.repo, cmp.baseRef, cmp.source, f)
  );
  await openMultiDiff(`Changes: ${cmp.target} ↔ ${cmp.source}`, resources);
}

async function openCommitDiff(
  node: CommitTreeNode,
  provider: CompareProvider
): Promise<void> {
  const cmp = provider.current;
  if (!cmp || !node || node.kind !== 'commit') {
    return;
  }
  const commit = node.commit;
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
