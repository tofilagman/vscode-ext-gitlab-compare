import * as vscode from 'vscode';
import { Branch } from './git';

/** A repository the user can compare branches in. */
export interface RepoInfo {
  /** Absolute repo root path. */
  path: string;
  /** Basename, shown in the dropdown. */
  name: string;
}

/** The comparison the user asked for on the compare page. */
export interface CompareSubmit {
  repo: string;
  target: string;
  source: string;
  threeDot: boolean;
}

/** Result of running a submitted comparison. */
export type SubmitResult = { ok: true } | { ok: false; error: string };

/** Data used to (re)populate the page. */
export interface CompareState {
  repo: string;
  branches: Branch[];
  source?: string;
  target?: string;
  threeDot: boolean;
}

export interface CompareHandlers {
  /** Load the branch list for a repo when the repo dropdown changes. */
  loadBranches(repo: string): Promise<Branch[]>;
  /** Run the comparison; resolve ok:true to close the page. */
  submit(req: CompareSubmit): Promise<SubmitResult>;
}

/**
 * A GitLab-style "compare branches" page: pick repo, source and target
 * branches, and the diff mode, then hit Compare. Rendered as a singleton
 * webview panel that reveals (rather than duplicates) if reopened.
 */
export class ComparePanel {
  private static readonly viewType = 'branchCompare.comparePage';
  private static instance: ComparePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(
    repos: RepoInfo[],
    state: CompareState,
    handlers: CompareHandlers
  ): void {
    if (ComparePanel.instance) {
      ComparePanel.instance.handlers = handlers;
      ComparePanel.instance.panel.reveal(vscode.ViewColumn.Active);
      ComparePanel.instance.post({ type: 'init', repos, state });
      return;
    }
    ComparePanel.instance = new ComparePanel(repos, state, handlers);
  }

  private constructor(
    private repos: RepoInfo[],
    private state: CompareState,
    private handlers: CompareHandlers
  ) {
    this.panel = vscode.window.createWebviewPanel(
      ComparePanel.viewType,
      'Compare Branches',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.iconPath = new vscode.ThemeIcon('git-compare');
    this.panel.webview.html = this.html();

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.onMessage(msg),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        this.post({ type: 'init', repos: this.repos, state: this.state });
        return;
      case 'requestBranches': {
        try {
          const branches = await this.handlers.loadBranches(msg.repo);
          this.post({ type: 'branches', repo: msg.repo, branches });
        } catch (err) {
          this.post({
            type: 'branches',
            repo: msg.repo,
            branches: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case 'submit': {
        const req: CompareSubmit = {
          repo: msg.repo,
          target: msg.target,
          source: msg.source,
          threeDot: !!msg.threeDot,
        };
        const result = await this.handlers.submit(req);
        if (result.ok) {
          this.dispose();
        } else {
          this.post({ type: 'error', message: result.error });
        }
        return;
      }
    }
  }

  private dispose(): void {
    ComparePanel.instance = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private html(): string {
    const nonce = makeNonce();
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    color-scheme: light dark;
    /* Semantic palette shared with the Merge Resolver extension: the two sides
       are colored by role — TARGET (base/left) pink, SOURCE (right) green. */
    --color-ours: #f472d0;    /* target / base */
    --color-theirs: #4ade80;  /* source / changes */
    --color-done: #7ee787;
    --bg-ours: rgba(244, 114, 208, 0.13);
    --bg-ours-active: rgba(244, 114, 208, 0.26);
    --bg-theirs: rgba(74, 222, 128, 0.13);
    --bg-theirs-active: rgba(74, 222, 128, 0.26);
    --radius: 4px;
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 26px 22px;
    margin: 0 auto;
    max-width: 760px;
  }
  h1 {
    font-size: 1.4em;
    font-weight: 600;
    margin: 0 0 4px;
  }
  .subtitle {
    color: var(--vscode-descriptionForeground);
    margin: 0 0 26px;
  }
  .field { margin-bottom: 18px; }
  label {
    display: flex;
    align-items: center;
    font-weight: 600;
    margin-bottom: 6px;
  }
  /* Role dot echoing the pane accent color, like the Merge Resolver headers. */
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    margin-right: 7px;
    flex: none;
  }
  .dot.ours { background: var(--color-ours); box-shadow: 0 0 0 3px var(--bg-ours-active); }
  .dot.theirs { background: var(--color-theirs); box-shadow: 0 0 0 3px var(--bg-theirs-active); }
  .hint {
    font-weight: 400;
    color: var(--vscode-descriptionForeground);
    margin-left: 6px;
    font-size: 0.9em;
  }
  select {
    width: 100%;
    padding: 6px 8px;
    color: var(--vscode-settings-dropdownForeground, var(--vscode-input-foreground));
    background: var(--vscode-settings-dropdownBackground, var(--vscode-input-background));
    border: 1px solid var(--vscode-settings-dropdownBorder, var(--vscode-input-border, transparent));
    border-radius: var(--radius);
    font-family: inherit;
    font-size: inherit;
  }
  select:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .branches {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    gap: 12px;
    align-items: end;
  }
  /* Swap button styled like the Merge Resolver secondary toolbar buttons. */
  .swap {
    height: 32px;
    width: 34px;
    margin-bottom: 1px;
    cursor: pointer;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    border: 1px solid transparent;
    border-radius: var(--radius);
    font-size: 16px;
    line-height: 1;
  }
  .swap:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .combo { position: relative; }
  .combo-input {
    width: 100%;
    padding: 6px 8px 6px 11px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: var(--radius);
    font-family: inherit;
    font-size: inherit;
  }
  .combo-input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  /* Colored accent bar on each field, matching its role — pink target, green source. */
  .combo-target .combo-input { box-shadow: inset 3px 0 0 var(--color-ours); }
  .combo-source .combo-input { box-shadow: inset 3px 0 0 var(--color-theirs); }
  .combo-list {
    position: absolute;
    z-index: 20;
    left: 0;
    right: 0;
    top: calc(100% + 2px);
    max-height: 280px;
    overflow-y: auto;
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-focusBorder));
    border-radius: var(--radius);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    display: none;
  }
  .combo-list.open { display: block; }
  .combo-item {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 5px 8px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
  }
  .combo-item .name { overflow: hidden; text-overflow: ellipsis; }
  /* Highlighted / hovered rows tint to the field's role color. */
  .combo-target .combo-item.active { background: var(--bg-ours-active); }
  .combo-source .combo-item.active { background: var(--bg-theirs-active); }
  .combo-target .combo-item:not(.active):hover { background: var(--bg-ours); }
  .combo-source .combo-item:not(.active):hover { background: var(--bg-theirs); }
  .combo-item.current .name { font-weight: 600; }
  /* "current" / "remote" tags as tinted pills, like the Merge Resolver labels. */
  .combo-item .badge {
    flex: none;
    padding: 0 7px;
    border-radius: 9px;
    font-size: 0.8em;
    line-height: 1.5;
    background: rgba(127, 127, 127, 0.18);
    color: var(--vscode-descriptionForeground);
  }
  .combo-target .combo-item.current .badge {
    background: var(--bg-ours-active);
    color: var(--vscode-foreground);
    box-shadow: inset 0 0 0 1px var(--color-ours);
  }
  .combo-source .combo-item.current .badge {
    background: var(--bg-theirs-active);
    color: var(--vscode-foreground);
    box-shadow: inset 0 0 0 1px var(--color-theirs);
  }
  .combo-empty, .combo-more {
    padding: 6px 8px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
  fieldset {
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent));
    border-radius: 6px;
    padding: 12px 14px;
    margin: 0 0 18px;
  }
  legend { font-weight: 600; padding: 0 4px; }
  .radio {
    display: flex;
    gap: 10px;
    align-items: baseline;
    margin: 6px 0;
    cursor: pointer;
  }
  .radio input { margin-top: 2px; accent-color: var(--color-theirs); }
  .radio .rlabel { font-weight: 600; }
  .radio .rdesc {
    display: block;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 22px;
  }
  button.primary {
    padding: 7px 18px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    font-weight: 600;
    transition: background 0.15s ease, box-shadow 0.2s ease, opacity 0.15s ease;
  }
  /* Ready to compare: a gentle green pulse, mirroring the Merge Resolver's
     "Save lights up when resolved" affordance. */
  button.primary:not(:disabled) {
    animation: ready-pulse 2s ease-in-out infinite;
  }
  button.primary:not(:disabled):hover {
    background: var(--vscode-button-hoverBackground);
    animation: none;
    box-shadow: 0 0 0 3px rgba(126, 231, 135, 0.4);
  }
  button.primary:disabled {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    opacity: 0.55;
    cursor: not-allowed;
    font-weight: 500;
  }
  @keyframes ready-pulse {
    0%, 100% { box-shadow: 0 0 0 2px rgba(126, 231, 135, 0.32); }
    50% { box-shadow: 0 0 0 5px rgba(126, 231, 135, 0.1); }
  }
  .error {
    color: var(--vscode-errorForeground);
    min-height: 1.2em;
  }
  .repo-field.hidden { display: none; }
</style>
</head>
<body>
  <h1>Compare branches</h1>
  <p class="subtitle">Review the changes on one branch relative to another — no merge request required.</p>

  <div class="field repo-field hidden" id="repoField">
    <label for="repo">Repository</label>
    <select id="repo"></select>
  </div>

  <div class="field">
    <div class="branches">
      <div>
        <label for="targetInput"><span class="dot ours"></span>Target <span class="hint">base — merge into</span></label>
        <div class="combo combo-target">
          <input type="text" id="targetInput" class="combo-input" autocomplete="off"
                 spellcheck="false" placeholder="Search branches…" />
          <div class="combo-list" id="targetList"></div>
        </div>
      </div>
      <button class="swap" id="swap" title="Swap target and source">⇄</button>
      <div>
        <label for="sourceInput"><span class="dot theirs"></span>Source <span class="hint">changes to review</span></label>
        <div class="combo combo-source">
          <input type="text" id="sourceInput" class="combo-input" autocomplete="off"
                 spellcheck="false" placeholder="Search branches…" />
          <div class="combo-list" id="sourceList"></div>
        </div>
      </div>
    </div>
  </div>

  <fieldset>
    <legend>Diff mode</legend>
    <label class="radio">
      <input type="radio" name="mode" value="merge-base" />
      <span>
        <span class="rlabel">Merge-base (three-dot)</span>
        <span class="rdesc">Only changes introduced on the source since it diverged. Matches a merge request.</span>
      </span>
    </label>
    <label class="radio">
      <input type="radio" name="mode" value="direct" />
      <span>
        <span class="rlabel">Direct (two-dot)</span>
        <span class="rdesc">Every difference between the two branch tips.</span>
      </span>
    </label>
  </fieldset>

  <div class="actions">
    <button class="primary" id="compare">Compare</button>
    <span class="error" id="error"></span>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const repoField = $('repoField');
  const repoSel = $('repo');
  const errorEl = $('error');
  const compareBtn = $('compare');

  // Cap how many matches we render at once; filtering a few thousand branch
  // names per keystroke is cheap, but painting them all is not.
  const MAX_RESULTS = 500;

  /** A searchable branch combobox: type to filter, arrows/enter to pick. */
  function createCombo(input, list, onChange) {
    let items = [];      // [{ name, current, remote }]
    let filtered = [];   // current matches
    let value = '';      // committed selection
    let active = -1;     // highlighted index into the filtered list
    let open = false;

    function render() {
      const q = input.value.trim().toLowerCase();
      filtered = q ? items.filter((b) => b.name.toLowerCase().includes(q)) : items.slice();
      list.textContent = '';
      if (filtered.length === 0) {
        const d = document.createElement('div');
        d.className = 'combo-empty';
        d.textContent = 'No matching branches';
        list.appendChild(d);
        active = -1;
        return;
      }
      if (active >= filtered.length) active = filtered.length - 1;
      if (active < 0) active = 0;
      const shown = filtered.slice(0, MAX_RESULTS);
      shown.forEach((b, i) => {
        const el = document.createElement('div');
        el.className = 'combo-item' + (b.current ? ' current' : '') + (i === active ? ' active' : '');
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = b.name;
        el.appendChild(name);
        const tags = [b.current ? 'current' : '', b.remote ? 'remote' : ''].filter(Boolean).join(' · ');
        if (tags) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = tags;
          el.appendChild(badge);
        }
        // mousedown (not click) so it fires before the input's blur.
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          commit(b.name);
          setOpen(false);
        });
        list.appendChild(el);
      });
      if (filtered.length > shown.length) {
        const more = document.createElement('div');
        more.className = 'combo-more';
        more.textContent = (filtered.length - shown.length) + ' more… keep typing to narrow';
        list.appendChild(more);
      }
    }

    function scrollActive() {
      const el = list.children[active];
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }

    function setOpen(o) {
      open = o;
      list.classList.toggle('open', o);
      if (o) {
        active = Math.max(0, filtered.findIndex((b) => b.name === value));
        render();
        scrollActive();
      } else {
        input.value = value; // revert any half-typed text
      }
    }

    function commit(name) {
      const changed = name !== value;
      value = name;
      input.value = name;
      if (changed) onChange();
    }

    input.addEventListener('focus', () => { input.select(); setOpen(true); });
    input.addEventListener('blur', () => setOpen(false));
    input.addEventListener('input', () => {
      open = true;
      list.classList.add('open');
      active = 0;
      render();
      scrollActive();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!open) { setOpen(true); return; }
        active = Math.min(active + 1, Math.min(filtered.length, MAX_RESULTS) - 1);
        render(); scrollActive();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        active = Math.max(active - 1, 0);
        render(); scrollActive();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (open && active >= 0 && active < filtered.length) {
          commit(filtered[active].name);
          setOpen(false);
        }
      } else if (e.key === 'Escape') {
        setOpen(false);
        input.blur();
      }
    });

    return {
      setItems(branches, selected) {
        items = branches || [];
        value = selected && items.some((b) => b.name === selected)
          ? selected
          : (items[0] ? items[0].name : '');
        input.value = value;
      },
      getValue: () => value,
      setValue(name) { value = name; input.value = name; },
      setEnabled(on) { input.disabled = !on; if (!on) input.value = ''; },
    };
  }

  let repos = [];
  const source = createCombo($('sourceInput'), $('sourceList'), validate);
  const target = createCombo($('targetInput'), $('targetList'), validate);

  function fillBranches(branches, src, tgt) {
    source.setItems(branches, src);
    target.setItems(branches, tgt);
    validate();
  }

  function validate() {
    const s = source.getValue();
    const t = target.getValue();
    const same = s && s === t;
    const empty = !s || !t;
    compareBtn.disabled = same || empty;
    errorEl.textContent = same ? 'Pick two different branches.' : '';
  }

  function selectedMode() {
    const el = document.querySelector('input[name="mode"]:checked');
    return el ? el.value : 'merge-base';
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      repos = msg.repos || [];
      repoSel.innerHTML = '';
      for (const r of repos) {
        const opt = document.createElement('option');
        opt.value = r.path;
        opt.textContent = r.name;
        if (r.path === msg.state.repo) opt.selected = true;
        repoSel.appendChild(opt);
      }
      repoField.classList.toggle('hidden', repos.length < 2);
      const mode = msg.state.threeDot ? 'merge-base' : 'direct';
      const modeEl = document.querySelector('input[name="mode"][value="' + mode + '"]');
      if (modeEl) modeEl.checked = true;
      source.setEnabled(true);
      target.setEnabled(true);
      fillBranches(msg.state.branches || [], msg.state.source, msg.state.target);
    } else if (msg.type === 'branches') {
      if (msg.error) errorEl.textContent = msg.error;
      const branches = msg.branches || [];
      const preferred = ['main', 'master', 'develop', 'trunk'];
      const current = branches.find((b) => b.current);
      const src = current ? current.name : (branches[0] && branches[0].name);
      let tgt;
      for (const p of preferred) {
        const m = branches.find((b) => b.name === p && b.name !== src);
        if (m) { tgt = m.name; break; }
      }
      if (!tgt) {
        const other = branches.find((b) => b.name !== src);
        tgt = other ? other.name : (branches[0] && branches[0].name);
      }
      source.setEnabled(true);
      target.setEnabled(true);
      fillBranches(branches, src, tgt);
    } else if (msg.type === 'error') {
      errorEl.textContent = msg.message || 'Comparison failed.';
      compareBtn.disabled = false;
      compareBtn.textContent = 'Compare';
    }
  });

  repoSel.addEventListener('change', () => {
    errorEl.textContent = '';
    source.setEnabled(false);
    target.setEnabled(false);
    compareBtn.disabled = true;
    vscode.postMessage({ type: 'requestBranches', repo: repoSel.value });
  });
  $('swap').addEventListener('click', () => {
    const s = source.getValue();
    source.setValue(target.getValue());
    target.setValue(s);
    validate();
  });
  compareBtn.addEventListener('click', () => {
    if (compareBtn.disabled) return;
    errorEl.textContent = '';
    compareBtn.disabled = true;
    compareBtn.textContent = 'Comparing…';
    vscode.postMessage({
      type: 'submit',
      repo: repoSel.value,
      source: source.getValue(),
      target: target.getValue(),
      threeDot: selectedMode() === 'merge-base',
    });
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
