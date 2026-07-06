import * as vscode from 'vscode';
import * as path from 'path';
import { ChangedFile, Commit, commitFiles, listCommits } from './git';
import { decorationUri } from './compareProvider';

interface CommitNode {
  kind: 'commit';
  commit: Commit;
}
interface CommitFileNode {
  kind: 'commitFile';
  commit: Commit;
  file: ChangedFile;
}
export type CommitTreeNode = CommitNode | CommitFileNode;

/** The subset of comparison state the Commits view needs. */
export interface CommitScope {
  repo: string;
  target: string;
  source: string;
}

export class CommitsProvider implements vscode.TreeDataProvider<CommitTreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<CommitTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private scope: CommitScope | undefined;
  private commits: Commit[] = [];
  private _truncated = false;
  /** Lazily-loaded per-commit file lists, keyed by sha. */
  private readonly fileCache = new Map<string, ChangedFile[]>();

  get count(): number {
    return this.commits.length;
  }

  /** True when the list was capped at branchCompare.maxCommits. */
  get truncated(): boolean {
    return this._truncated;
  }

  /** Point the view at a comparison (or clear it with undefined). */
  async setScope(scope: CommitScope | undefined): Promise<void> {
    this.scope = scope;
    this.fileCache.clear();
    const maxCommits = vscode.workspace
      .getConfiguration('branchCompare')
      .get<number>('maxCommits', 500);
    this.commits = scope
      ? await listCommits(scope.repo, scope.target, scope.source, maxCommits)
      : [];
    this._truncated = maxCommits > 0 && this.commits.length >= maxCommits;
    this._onDidChange.fire(undefined);
  }

  clear(): void {
    this.scope = undefined;
    this.commits = [];
    this._truncated = false;
    this.fileCache.clear();
    this._onDidChange.fire(undefined);
  }

  async getChildren(element?: CommitTreeNode): Promise<CommitTreeNode[]> {
    if (!this.scope) {
      return [];
    }
    if (!element) {
      return this.commits.map((commit) => ({ kind: 'commit', commit }));
    }
    if (element.kind === 'commit') {
      const files = await this.filesFor(element.commit.sha);
      return files.map((file) => ({ kind: 'commitFile', commit: element.commit, file }));
    }
    return [];
  }

  private async filesFor(sha: string): Promise<ChangedFile[]> {
    let files = this.fileCache.get(sha);
    if (!files) {
      files = await commitFiles(this.scope!.repo, sha);
      this.fileCache.set(sha, files);
    }
    return files;
  }

  getTreeItem(element: CommitTreeNode): vscode.TreeItem {
    if (element.kind === 'commit') {
      const c = element.commit;
      const item = new vscode.TreeItem(
        c.subject || '(no commit message)',
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.description = `${c.shortSha} · ${c.relativeDate}`;
      item.iconPath = new vscode.ThemeIcon('git-commit');
      item.tooltip = new vscode.MarkdownString(
        `**${c.subject}**\n\n` +
          `\`${c.shortSha}\` · ${c.author} <${c.authorEmail}>\n\n` +
          `${c.isoDate}${c.parents.length > 1 ? '\n\n*merge commit*' : ''}`
      );
      item.contextValue = 'commit';
      return item;
    }

    const f = element.file;
    const item = new vscode.TreeItem(
      path.posix.basename(f.path),
      vscode.TreeItemCollapsibleState.None
    );
    const dir = path.posix.dirname(f.path);
    item.description = dir === '.' ? '' : dir;
    item.resourceUri = decorationUri(f);
    item.tooltip = f.binary
      ? `${f.path} · binary`
      : `${f.path} · +${f.insertions ?? 0} −${f.deletions ?? 0}`;
    item.contextValue = 'commitFile';
    item.command = {
      command: 'branchCompare.openCommitChange',
      title: 'Open Commit Change',
      arguments: [element],
    };
    return item;
  }
}
