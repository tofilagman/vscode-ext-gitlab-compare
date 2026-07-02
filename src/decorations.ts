import * as vscode from 'vscode';

/**
 * Colors and single-letter badges for change status, mirroring the git badges
 * VS Code shows in the SCM view. Applied to gitlab-compare-file: URIs whose
 * query is the status letter.
 */
export class ChangeDecorationProvider implements vscode.FileDecorationProvider {
  static readonly scheme = 'gitlab-compare-file';

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== ChangeDecorationProvider.scheme) {
      return undefined;
    }
    const status = uri.query;
    switch (status) {
      case 'A':
        return badge('A', 'gitDecoration.addedResourceForeground', 'Added');
      case 'M':
        return badge('M', 'gitDecoration.modifiedResourceForeground', 'Modified');
      case 'D':
        return badge('D', 'gitDecoration.deletedResourceForeground', 'Deleted');
      case 'R':
        return badge('R', 'gitDecoration.renamedResourceForeground', 'Renamed');
      case 'C':
        return badge('C', 'gitDecoration.renamedResourceForeground', 'Copied');
      case 'T':
        return badge('T', 'gitDecoration.modifiedResourceForeground', 'Type changed');
      case 'U':
        return badge('U', 'gitDecoration.conflictingResourceForeground', 'Unmerged');
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
