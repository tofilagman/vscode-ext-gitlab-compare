import * as vscode from 'vscode';
import * as path from 'path';
import {
  ChangedFile,
  changedFiles,
  diffShortStat,
  mergeBase,
} from './git';

/** A resolved comparison between two branches. */
export interface Comparison {
  repo: string;
  /** Base branch (the thing you merge into). */
  target: string;
  /** Source branch (the thing whose changes you review). */
  source: string;
  /** Ref used as the "left"/old side of every file diff. */
  baseRef: string;
  /** merge-base (three-dot) vs direct (two-dot). */
  threeDot: boolean;
  files: ChangedFile[];
  stat: { insertions: number; deletions: number; filesChanged: number };
}

interface FolderNode {
  kind: 'folder';
  name: string;
  path: string;
  children: TreeNode[];
}
interface FileNode {
  kind: 'file';
  file: ChangedFile;
}
export type TreeNode = FolderNode | FileNode;

const STATUS_LABEL: Record<string, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Unmerged',
};

export class CompareProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private comparison: Comparison | undefined;
  private roots: TreeNode[] = [];

  get current(): Comparison | undefined {
    return this.comparison;
  }

  /** Compute (or recompute) the comparison for the given branches and mode. */
  async setComparison(
    repo: string,
    target: string,
    source: string,
    threeDot: boolean
  ): Promise<void> {
    const baseRef = threeDot ? await mergeBase(repo, target, source) : target;
    const [files, stat] = await Promise.all([
      changedFiles(repo, target, source, threeDot),
      diffShortStat(repo, target, source, threeDot),
    ]);
    this.comparison = { repo, target, source, baseRef, threeDot, files, stat };
    this.roots = buildTree(files);
    this._onDidChange.fire(undefined);
  }

  /** Re-run the current comparison (e.g. after new commits land). */
  async refresh(): Promise<void> {
    if (!this.comparison) {
      return;
    }
    const { repo, target, source, threeDot } = this.comparison;
    await this.setComparison(repo, target, source, threeDot);
  }

  async swap(): Promise<void> {
    if (!this.comparison) {
      return;
    }
    const { repo, target, source, threeDot } = this.comparison;
    await this.setComparison(repo, source, target, threeDot);
  }

  async toggleMode(): Promise<void> {
    if (!this.comparison) {
      return;
    }
    const { repo, target, source, threeDot } = this.comparison;
    await this.setComparison(repo, target, source, !threeDot);
  }

  clear(): void {
    this.comparison = undefined;
    this.roots = [];
    this._onDidChange.fire(undefined);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!this.comparison) {
      return [];
    }
    if (!element) {
      return this.roots;
    }
    return element.kind === 'folder' ? element.children : [];
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'folder') {
      const item = new vscode.TreeItem(
        element.name,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = 'folder';
      return item;
    }

    const f = element.file;
    const item = new vscode.TreeItem(
      path.posix.basename(f.path),
      vscode.TreeItemCollapsibleState.None
    );
    // Directory shown dimmed after the filename, VS Code search-result style.
    const dir = path.posix.dirname(f.path);
    item.description = dir === '.' ? '' : dir;
    item.resourceUri = decorationUri(f);
    item.tooltip = this.tooltipFor(f);
    item.contextValue = 'file';
    item.command = {
      command: 'branchCompare.openChange',
      title: 'Open Change',
      arguments: [element],
    };
    return item;
  }

  private tooltipFor(f: ChangedFile): string {
    const label = STATUS_LABEL[f.status] ?? f.status;
    if ((f.status === 'R' || f.status === 'C') && f.oldPath) {
      return `${label}: ${f.oldPath} → ${f.path}`;
    }
    return `${label}: ${f.path}`;
  }
}

/** Encode a change into a decoration URI (see FileDecorationProvider). */
export function decorationUri(f: ChangedFile): vscode.Uri {
  return vscode.Uri.from({
    scheme: 'branch-compare-file',
    path: '/' + f.path,
    query: f.status,
  });
}

function buildTree(files: ChangedFile[]): TreeNode[] {
  const root: FolderNode = { kind: 'folder', name: '', path: '', children: [] };
  for (const file of files) {
    const segs = file.path.split('/');
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const name = segs[i];
      let child = cur.children.find(
        (c): c is FolderNode => c.kind === 'folder' && c.name === name
      );
      if (!child) {
        child = {
          kind: 'folder',
          name,
          path: cur.path ? `${cur.path}/${name}` : name,
          children: [],
        };
        cur.children.push(child);
      }
      cur = child;
    }
    cur.children.push({ kind: 'file', file });
  }
  compactChildren(root);
  sortNode(root);
  return root.children;
}

/** Collapse single-child folder chains (src → src/main → src/main/app). */
function compactChildren(node: FolderNode): void {
  for (const child of node.children) {
    if (child.kind !== 'folder') {
      continue;
    }
    while (child.children.length === 1 && child.children[0].kind === 'folder') {
      const only = child.children[0];
      child.name = `${child.name}/${only.name}`;
      child.path = only.path;
      child.children = only.children;
    }
    compactChildren(child);
  }
}

function sortNode(node: FolderNode): void {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'folder' ? -1 : 1;
    }
    const an = a.kind === 'folder' ? a.name : path.posix.basename(a.file.path);
    const bn = b.kind === 'folder' ? b.name : path.posix.basename(b.file.path);
    return an.localeCompare(bn);
  });
  for (const child of node.children) {
    if (child.kind === 'folder') {
      sortNode(child);
    }
  }
}
