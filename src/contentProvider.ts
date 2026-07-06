import * as vscode from 'vscode';
import { git } from './git';

/** Query payload encoded into branch-compare: URIs. */
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
 * URI shape:  branch-compare:/<display path>?<json RefQuery>
 * The path segment keeps the real filename/extension so language detection and
 * the editor title work; the query carries the ref actually read.
 */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'branch-compare';

  /**
   * Blob contents keyed by URI. Branch refs can move, so the extension clears
   * this whenever the comparison is (re)computed; within one comparison the
   * content is stable and re-opening diffs costs no extra git calls.
   */
  private readonly cache = new Map<string, string>();

  static toUri(query: RefQuery): vscode.Uri {
    return vscode.Uri.from({
      scheme: GitContentProvider.scheme,
      // Leading slash + real relative path -> nice title & correct language.
      path: '/' + query.relPath,
      query: JSON.stringify(query),
    });
  }

  clearCache(): void {
    this.cache.clear();
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let query: RefQuery;
    try {
      query = JSON.parse(uri.query);
    } catch {
      return '';
    }
    if (!query.ref || !query.relPath) {
      return '';
    }

    let content: string;
    try {
      // `git show <ref>:<path>` prints the blob at that ref. If the path does
      // not exist there (added on one side / deleted on the other) git exits
      // non-zero — we treat that as empty content so the diff shows the file
      // as fully added or removed.
      content = await git(query.repo, ['show', `${query.ref}:${query.relPath}`]);
    } catch {
      content = '';
    }
    // Don't feed raw binary bytes to the text diff — show a short note instead.
    if (content.includes('\u0000')) {
      content = `(binary file: ${query.relPath} @ ${query.ref})\n`;
    }

    if (this.cache.size > 500) {
      this.cache.clear();
    }
    this.cache.set(key, content);
    return content;
  }
}
