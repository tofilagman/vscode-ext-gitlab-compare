import { execFile } from 'child_process';

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface ChangedFile {
  /** Status of the change (added, modified, deleted, renamed, ...). */
  status: ChangeStatus;
  /** Path in the source branch (the "new" path). Forward-slash separated, repo-relative. */
  path: string;
  /** For renames/copies, the original path in the target branch. */
  oldPath?: string;
  /** Rename/copy similarity percentage, when reported by git. */
  score?: number;
}

export interface Branch {
  name: string;
  /** True for remote-tracking branches (e.g. origin/main). */
  remote: boolean;
  /** Whether this is the currently checked-out branch. */
  current: boolean;
}

export interface Commit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authorEmail: string;
  /** Human-friendly relative date, e.g. "3 days ago". */
  relativeDate: string;
  /** Author date, ISO 8601. */
  isoDate: string;
  /** Parent shas (more than one for a merge commit). */
  parents: string[];
}

/** The empty-tree object hash, used as the "parent" of a root commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Thrown when a git invocation exits non-zero. */
export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Run a git command in `repo` and return stdout. Rejects with a GitError on
 * non-zero exit. A generous buffer is used so large `git show` outputs fit.
 */
export function git(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repo, ...args],
      { maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new GitError(`git ${args.join(' ')} failed: ${err.message}`, stderr));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/** Resolve the repository root that contains `cwd`, or null if not a repo. */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ['rev-parse', '--show-toplevel']);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** List local (and optionally remote-tracking) branches, most-recent first. */
export async function listBranches(repo: string, includeRemote: boolean): Promise<Branch[]> {
  const refspecs = ['refs/heads'];
  if (includeRemote) {
    refspecs.push('refs/remotes');
  }
  const out = await git(repo, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)%09%(HEAD)',
    ...refspecs,
  ]);

  const branches: Branch[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const [name, head] = line.split('\t');
    // Skip the symbolic "origin/HEAD -> origin/main" entry.
    if (!name || name.endsWith('/HEAD')) {
      continue;
    }
    branches.push({
      name,
      remote: name.includes('/') && !name.startsWith('refs/heads'),
      current: head === '*',
    });
  }
  return branches;
}

/** Return the merge-base (common ancestor) sha of two refs. */
export async function mergeBase(repo: string, a: string, b: string): Promise<string> {
  const out = await git(repo, ['merge-base', a, b]);
  return out.trim();
}

/**
 * List files changed between `base` and `source`.
 * When `threeDot` is true the git "triple-dot" range (base...source) is used,
 * matching what GitLab shows for a merge request.
 */
export async function changedFiles(
  repo: string,
  base: string,
  source: string,
  threeDot: boolean
): Promise<ChangedFile[]> {
  const range = threeDot ? `${base}...${source}` : `${base}..${source}`;
  const out = await git(repo, [
    'diff',
    '--name-status',
    '--find-renames',
    '-z',
    range,
  ]);
  return parseNameStatusZ(out);
}

/**
 * List files changed by a single commit, versus its first parent (or the empty
 * tree for a root commit). Used to drill into a commit in the Commits view.
 */
export async function commitFiles(repo: string, sha: string): Promise<ChangedFile[]> {
  const parent = await git(repo, ['rev-list', '--parents', '-n', '1', sha]);
  const shas = parent.trim().split(/\s+/);
  const base = shas.length > 1 ? shas[1] : EMPTY_TREE;
  // Two tree-ish args (not a range) so this also works against the empty tree.
  const out = await git(repo, [
    'diff',
    '--name-status',
    '--find-renames',
    '-z',
    base,
    sha,
  ]);
  return parseNameStatusZ(out);
}

/**
 * Parse `git diff --name-status -z` output. With -z, records are NUL-separated.
 * A rename/copy record spans three fields ("R100", oldPath, newPath); all
 * others span two (status, path).
 */
function parseNameStatusZ(out: string): ChangedFile[] {
  const parts = out.split('\0').filter((p) => p.length > 0);
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < parts.length) {
    const raw = parts[i++];
    const status = raw[0] as ChangeStatus;
    const score = raw.length > 1 ? parseInt(raw.slice(1), 10) : undefined;
    if (status === 'R' || status === 'C') {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      files.push({ status, path: newPath, oldPath, score });
    } else {
      const path = parts[i++];
      files.push({ status, path, score: Number.isNaN(score as number) ? undefined : score });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * List commits present in `source` but not in `target` (target..source) — the
 * commits that a merge request from source into target would contribute, and
 * exactly what GitLab shows on an MR's Commits tab.
 */
export async function listCommits(
  repo: string,
  target: string,
  source: string
): Promise<Commit[]> {
  // Field separator \x1f, record separator \x1e — neither appears in commit
  // metadata, so this survives multi-line/odd subjects.
  const fields = ['%H', '%h', '%s', '%an', '%ae', '%ar', '%aI', '%P'].join('%x1f');
  const out = await git(repo, [
    'log',
    `${target}..${source}`,
    `--format=%x1e${fields}`,
    '--no-color',
  ]);

  const commits: Commit[] = [];
  for (const record of out.split('\x1e')) {
    if (!record.trim()) {
      continue;
    }
    const [sha, shortSha, subject, author, authorEmail, relativeDate, isoDate, parents] =
      record.replace(/^\n/, '').split('\x1f');
    commits.push({
      sha,
      shortSha,
      subject,
      author,
      authorEmail,
      relativeDate,
      isoDate,
      parents: parents ? parents.trim().split(/\s+/).filter(Boolean) : [],
    });
  }
  return commits;
}

/** Diff stat (insertions/deletions) for the whole comparison. */
export async function diffShortStat(
  repo: string,
  base: string,
  source: string,
  threeDot: boolean
): Promise<{ insertions: number; deletions: number; filesChanged: number }> {
  const range = threeDot ? `${base}...${source}` : `${base}..${source}`;
  const out = await git(repo, ['diff', '--shortstat', range]);
  const filesChanged = /(\d+) files? changed/.exec(out)?.[1];
  const insertions = /(\d+) insertions?\(\+\)/.exec(out)?.[1];
  const deletions = /(\d+) deletions?\(-\)/.exec(out)?.[1];
  return {
    filesChanged: filesChanged ? parseInt(filesChanged, 10) : 0,
    insertions: insertions ? parseInt(insertions, 10) : 0,
    deletions: deletions ? parseInt(deletions, 10) : 0,
  };
}
