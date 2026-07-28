import * as vscode from 'vscode';

/**
 * Colors and single-letter badges for change status, following the IntelliJ
 * VCS scheme — added green, modified blue, deleted gray — via the
 * branchCompare.* theme colors contributed in package.json (overridable with
 * workbench.colorCustomizations). Applied to branch-compare-file: URIs whose
 * query is the status letter.
 */
export class ChangeDecorationProvider implements vscode.FileDecorationProvider {
  static readonly scheme = 'branch-compare-file';

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== ChangeDecorationProvider.scheme) {
      return undefined;
    }
    const status = uri.query;
    switch (status) {
      case 'A':
        return badge('A', 'branchCompare.addedForeground', 'Added');
      case 'M':
        return badge('M', 'branchCompare.modifiedForeground', 'Modified');
      case 'D':
        return badge('D', 'branchCompare.deletedForeground', 'Deleted');
      case 'R':
        return badge('R', 'branchCompare.modifiedForeground', 'Renamed');
      case 'C':
        return badge('C', 'branchCompare.addedForeground', 'Copied');
      case 'T':
        return badge('T', 'branchCompare.modifiedForeground', 'Type changed');
      case 'U':
        return badge('U', 'branchCompare.conflictForeground', 'Unmerged');
      default:
        return undefined;
    }
  }
}

function badge(letter: string, color: string, tooltip: string): vscode.FileDecoration {
  return {
    badge: letter,
    color: new vscode.ThemeColor(color),
    tooltip,
    propagate: false,
  };
}
