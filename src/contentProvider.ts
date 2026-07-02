import * as vscode from 'vscode';
import { git } from './git';

/** Query payload encoded into gitlab-compare: URIs. */
interface RefQuery {
  repo: string;
  ref: string;
  /** Repo-relative, forward-slash path to read at `ref`. */
  relPath: string;
}

/**
 * Serves the contents of a file at an arbitrary git ref through a virtual
 * document, so it can be fed to VS Code's built-in diff editor.
 *
 * URI shape:  gitlab-compare:/<display path>?<json RefQuery>
 * The path segment keeps the real filename/extension so language detection and
 * the editor title work; the query carries the ref actually read.
 */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'gitlab-compare';

  static toUri(query: RefQuery): vscode.Uri {
    return vscode.Uri.from({
      scheme: GitContentProvider.scheme,
      // Leading slash + real relative path -> nice title & correct language.
      path: '/' + query.relPath,
      query: JSON.stringify(query),
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let query: RefQuery;
    try {
      query = JSON.parse(uri.query);
    } catch {
      return '';
    }
    if (!query.ref || !query.relPath) {
      return '';
    }
    try {
      // `git show <ref>:<path>` prints the blob at that ref. If the path does
      // not exist there (added on one side / deleted on the other) git exits
      // non-zero — we treat that as empty content so the diff shows the file
      // as fully added or removed.
      return await git(query.repo, ['show', `${query.ref}:${query.relPath}`]);
    } catch {
      return '';
    }
  }
}
