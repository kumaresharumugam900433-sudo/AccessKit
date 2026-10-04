/* AccessKit — client app
   1. Config & state   2. Helpers   3. Scan engine   4. Rendering
   5. Views & tabs     6. Workspaces & history   7. Accounts   8. Billing
   9. Scanning         10. Init */
'use strict';

/* 1. Config & state ------------------------------------------------ */
const PREVIEW_LIMIT = 3;
const FREE_SCAN_KEY = 'accesskit_free_scan_used';
const VIEWS = ['overview', 'scans', 'issues', 'settings'];
const PLAN_LABELS = { monthly: 'monthly', halfyear: '6 months', yearly: '12 months' };
const SEVERITY_ORDER = { Critical: 0, High: 1, Low: 2 };

const AUTH_COPY = {
  login: {
    heading: 'Sign in to AccessKit',
    intro: 'Access your scans, workspaces and plan.',
    submit: 'Sign in',
    switchLabel: 'New here? Create an account',
    autocomplete: 'current-password',
  },
  register: {
    heading: 'Create your account',
    intro: 'Create a free account to unlock full reports and choose a plan.',
    submit: 'Create account',
    switchLabel: 'Already have an account? Sign in',
    autocomplete: 'new-password',
  },
};

const SAMPLE_HTML = `<main>
  <h1>Update your profile</h1>
  <form>
    <label for="email">Email address</label>
    <input id="email" type="email" value="alex@example.com">
    <button type="button" style="background:#ffffff;color:#cccccc;border:1px solid #eeeeee">Save changes</button>
    <div onclick="saveProfile()" style="background:#175f49;color:#fff;padding:10px">Save with custom control</div>
    <input type="checkbox" id="updates"><label for="updates">Send me product updates</label>
  </form>
</main>`;

const state = {
  view: 'overview',
  findings: [],
  activeTab: 'violations',
  hasScan: false,
  scanLabel: '',
  account: null,
  workspaces: [],
  workspaceId: null,
  savedScans: [],
  authMode: 'login',
  freeUsedInMemory: false,
};

/* 2. Helpers ------------------------------------------------------- */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

let toastTimer;
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 2800);
}

async function api(path, { method = 'GET', body, signal, fallback = 'Something went wrong. Please try again.' } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || fallback);
  return data;
}

function setStatus(element, message, type = '') {
  element.textContent = message;
  element.className = `url-status ${type}`.trim();
}

function revealResults() {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  $('#overviewView').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
}

/* Free preview: one anonymous scan, limited to the top findings. */
function freeScanUsed() {
  if (state.freeUsedInMemory) return true;
  try {
    return localStorage.getItem(FREE_SCAN_KEY) === '1';
  } catch {
    return false;
  }
}

function markFreeScanUsed() {
  state.freeUsedInMemory = true;
  try {
    localStorage.setItem(FREE_SCAN_KEY, '1');
  } catch {
    /* Storage unavailable; the in-memory flag still applies. */
  }
}

function renderFreeNote() {
  $('#freeNote').textContent = state.account
    ? ''
    : freeScanUsed()
      ? 'Free preview used. Sign in to keep scanning.'
      : 'Your first scan is free — no account needed.';
}

/* 3. Scan engine ---------------------------------------------------
   Small, independent rules. Add or replace rules inside scanMarkup(). */
function accessibleName(el) {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(' ');
  }

  if (el.id) {
    const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) return label.textContent.trim();
  }

  const wrappingLabel = el.closest('label');
  if (wrappingLabel) return wrappingLabel.textContent.trim();

  if (el.tagName === 'BUTTON' || el.tagName === 'A') {
    return el.textContent.trim() || el.getAttribute('title') || '';
  }
  return el.getAttribute('title') || '';
}

function parseColor(value) {
  if (!value) return null;
  const color = value.trim().toLowerCase();

  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/.test(hex)) return null;
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }

  const rgb = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

function relativeLuminance(rgb) {
  const [r, g, b] = rgb
    .map((n) => n / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function describeElement(el) {
  let selector = el.tagName.toLowerCase();
  if (el.id) selector += `#${el.id}`;
  else if (el.classList.length) selector += `.${[...el.classList].slice(0, 2).join('.')}`;
  return selector;
}

function scanMarkup(markup) {
  const doc = new DOMParser().parseFromString(markup, 'text/html');
  const found = [];
  const add = (category, severity, title, detail, el) =>
    found.push({ category, severity, title, detail, selector: describeElement(el) });

  const NATIVE_CONTROLS = ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'];

  // Keyboard: custom controls need a tabindex; positive values disturb focus order.
  doc.querySelectorAll('[onclick],[role="button"],[role="link"],[role="checkbox"],[role="tab"]').forEach((el) => {
    if (!NATIVE_CONTROLS.includes(el.tagName) && !el.hasAttribute('tabindex')) {
      add('Keyboard', 'High', 'Custom control may not be keyboard reachable',
        'This interactive element is not a native control and has no tabindex. Confirm it can receive focus and responds to Enter/Space as appropriate.', el);
    }
    if (Number(el.getAttribute('tabindex')) > 0) {
      add('Keyboard', 'Medium', 'Positive tabindex can disrupt focus order',
        'Prefer the natural DOM order with tabindex="0" or native controls.', el);
    }
  });

  // Names and roles: controls need an accessible name; custom toggles need state.
  doc.querySelectorAll('button,input:not([type="hidden"]),select,textarea,[role="button"],[role="checkbox"],[role="switch"],[role="tab"]').forEach((el) => {
    if (!accessibleName(el)) {
      add('Name & role', 'High', 'Control may have no accessible name',
        'Add a visible label, associated <label>, aria-label, or aria-labelledby. Check the computed name with a screen reader.', el);
    }
    if (['checkbox', 'switch', 'radio'].includes(el.getAttribute('role')) && !el.hasAttribute('aria-checked')) {
      add('Name & role', 'Medium', 'Custom state may be missing',
        'This custom role may need aria-checked and keyboard behavior that updates its state.', el);
    }
  });

  // Contrast: WCAG AA for explicit inline colors. Stylesheets, transparency and
  // images need the rendered URL scan.
  doc.querySelectorAll('[style*="color"],[style*="background"],[style*="border"]').forEach((el) => {
    const style = el.getAttribute('style') || '';
    const fg = parseColor(style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)?.[1]);
    const bg = parseColor(style.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i)?.[1]);
    const border = parseColor(style.match(/(?:^|;)\s*border(?:-color)?\s*:\s*(?:\d+(?:px|em)?\s+\w+\s+)?(#[\da-f]{3,8}|rgba?\([^)]*\))/i)?.[1]);
    const fontSize = style.match(/font-size\s*:\s*([\d.]+)px/i);
    const isLarge = fontSize && parseFloat(fontSize[1]) >= 24;
    const isControl = el.matches('button,a,input,select,textarea,[role],[onclick]');

    if (fg && bg) {
      const ratio = contrastRatio(fg, bg);
      const threshold = isLarge ? 3 : 4.5;
      if (ratio < threshold) {
        add('Contrast', 'High', `Low text contrast (${ratio.toFixed(2)}:1)`,
          `Explicit text/background colors are below ${threshold}:1 for ${isLarge ? 'large' : 'normal'} text (WCAG AA).`, el);
      }
    }
    if (isControl && fg && bg && contrastRatio(fg, bg) < 3) {
      add('Contrast', 'High', 'Control contrast below 3:1',
        'This control foreground/background pair is below 3:1. Check its visible boundary or icon against adjacent colors.', el);
    }
    if (isControl && border && bg && contrastRatio(border, bg) < 3) {
      add('Contrast', 'High', 'Control boundary contrast below 3:1',
        'The explicit border/background pair is below 3:1. Interface boundaries needed to identify a control should reach 3:1.', el);
    }
  });

  // Focus order and operability need a person, so always add a manual prompt.
  if (doc.querySelector('button,a,input,select,textarea,[onclick],[tabindex]')) {
    found.push({
      category: 'Keyboard',
      severity: 'Review',
      title: 'Manually test keyboard flow',
      detail: 'Tab through the page, confirm focus is visible and follows a logical order, and operate each control with the keyboard.',
      selector: 'Full page',
    });
  }
  return found;
}

function bucketOf(finding) {
  const text = `${finding.title || ''} ${finding.detail || ''}`;
  if (finding.severity === 'Review' || /manually test|manual check/i.test(text)) return 'manual';
  if (finding.severity === 'Medium' || /\bmay\b|potentially|possibly/i.test(text)) return 'review';
  return 'violations';
}

function severityOf(finding) {
  if (bucketOf(finding) === 'review') return 'Low';
  const title = finding.title || '';
  const ratio = title.match(/(\d+(?:\.\d+)?)\s*:\s*1/);
  if (ratio && Number(ratio[1]) < 3) return 'Critical';
  if (/control boundary.*below 3:1|graphic contrast below 3:1/i.test(title)) return 'Critical';
  return finding.severity === 'High' ? 'High' : 'Low';
}

const bySeverity = (a, b) => (SEVERITY_ORDER[severityOf(a)] ?? 3) - (SEVERITY_ORDER[severityOf(b)] ?? 3);

/* 4. Rendering ----------------------------------------------------- */
function isPreview() {
  return state.hasScan && !state.account;
}

function automatedFindings() {
  return state.findings.filter((f) => bucketOf(f) !== 'manual');
}

function severityCounts() {
  const counts = { critical: 0, high: 0, low: 0 };
  automatedFindings().forEach((f) => { counts[severityOf(f).toLowerCase()] += 1; });
  return counts;
}

function renderChart(counts) {
  const total = counts.critical + counts.high + counts.low;
  const slices = $('#pieSlices');
  const emptyPie = $('#emptyPie');
  const description = $('#chartDescription');
  const summary = $('#chartSummary');

  $('#criticalCount').textContent = counts.critical;
  $('#highCount').textContent = counts.high;
  $('#lowCount').textContent = counts.low;
  slices.innerHTML = '';
  emptyPie.style.display = '';

  if (!state.hasScan) {
    description.textContent = 'No scan has been run.';
    summary.textContent = 'Run a scan to see the breakdown.';
    return;
  }
  if (!total) {
    description.textContent = 'No automated findings: Critical 0, High 0, Low 0.';
    summary.textContent = 'No automated findings. Manual prompts are in the Manual checks tab.';
    return;
  }

  emptyPie.style.display = 'none';
  const entries = [['critical', '#a33b33'], ['high', '#a85b00'], ['low', '#43627f']].filter(([key]) => counts[key] > 0);
  const point = (degrees) => ({
    x: 60 + 50 * Math.cos((degrees * Math.PI) / 180),
    y: 60 + 50 * Math.sin((degrees * Math.PI) / 180),
  });

  let angle = -90;
  slices.innerHTML = entries.map(([key, color]) => {
    const sweep = counts[key] === total ? 359.999 : (counts[key] / total) * 360;
    const start = point(angle);
    const end = point(angle + sweep);
    angle += sweep;
    return `<path d="M 60 60 L ${start.x.toFixed(3)} ${start.y.toFixed(3)} A 50 50 0 ${sweep > 180 ? 1 : 0} 1 ${end.x.toFixed(3)} ${end.y.toFixed(3)} Z" fill="${color}"></path>`;
  }).join('');

  description.textContent = `${plural(total, 'automated finding')}: Critical ${counts.critical}, High ${counts.high}, Low ${counts.low}.`;
  summary.textContent = `${plural(total, 'automated finding')}. Manual prompts are excluded.`;
}

function renderHealth() {
  const counts = severityCounts();
  const total = counts.critical + counts.high + counts.low;
  const score = state.hasScan ? Math.max(0, 100 - counts.critical * 12 - counts.high * 6 - counts.low * 2) : null;

  $('#scoreContext').textContent = state.hasScan
    ? `${state.scanLabel || 'Latest scan'} · ${plural(total, 'automated finding')}`
    : 'Run a scan to see your score.';
  $('#healthScore').innerHTML = `${score ?? '—'}<small>/100</small>`;
  $('#scoreLabel').textContent =
    score === null ? 'Waiting for scan'
      : score >= 90 ? 'Strong'
        : score >= 75 ? 'Good starting point'
          : score >= 50 ? 'Needs attention'
            : 'Priority fixes needed';
  renderChart(counts);
}

function lockedCard(hidden) {
  const ghost = '<div class="ghost" aria-hidden="true"><i></i><i></i><i></i></div>';
  return `${ghost}${ghost}
    <section class="locked" aria-label="Locked findings">
      <h3>${plural(hidden, 'more finding')}</h3>
      <p>Create a free account or sign in to see every finding from this scan.</p>
      <div class="locked-actions">
        <button class="button primary" type="button" data-open-auth="register">Create free account</button>
        <button class="button" type="button" data-open-auth="login">Sign in</button>
      </div>
    </section>`;
}

function renderResults() {
  const buckets = { violations: [], review: [], manual: [] };
  state.findings.forEach((f) => buckets[bucketOf(f)].push(f));

  $('#confirmedTabCount').textContent = buckets.violations.length;
  $('#reviewTabCount').textContent = buckets.review.length;
  $('#manualTabCount').textContent = buckets.manual.length;

  const preview = isPreview();
  const allowed = new Set(preview ? [...automatedFindings()].sort(bySeverity).slice(0, PREVIEW_LIMIT) : []);
  const tabItems = buckets[state.activeTab];
  let visible = preview ? tabItems.filter((f) => bucketOf(f) === 'manual' || allowed.has(f)) : tabItems;
  if (preview) visible = [...visible].sort(bySeverity);
  const lockedCount = tabItems.length - visible.length;

  // Header, count and preview banner
  $('#resultCount').textContent = preview ? `${visible.length} of ${tabItems.length} shown` : plural(tabItems.length, 'finding');
  $('#resultSummary').textContent = state.hasScan
    ? `${plural(state.findings.length, 'result')}${preview ? ' · free preview' : ''}`
    : 'Run a scan to see results.';

  const hiddenTotal = Math.max(0, automatedFindings().length - PREVIEW_LIMIT);
  $('#previewBanner').hidden = !(preview && hiddenTotal > 0);
  $('#previewBannerText').innerHTML =
    `<strong>Free preview:</strong> showing the top ${PREVIEW_LIMIT} of ${automatedFindings().length} findings. Create a free account to see the rest.`;

  // Tabs
  $('#resultsPanel').setAttribute('aria-labelledby', `tab-${state.activeTab}`);
  $$('.results-tabs [role="tab"]').forEach((tab) => {
    const selected = tab.dataset.tab === state.activeTab;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });

  renderHealth();

  const list = $('#resultList');
  if (!visible.length && !lockedCount) {
    const empty = {
      violations: 'No violations found in this scan.',
      review: 'Nothing needs further review.',
      manual: 'No manual checks were generated.',
    };
    list.innerHTML = state.hasScan
      ? `<div class="empty"><strong>${empty[state.activeTab]}</strong>Try another tab or scan a different page.</div>`
      : '<div class="empty"><strong>No scan yet</strong>Run a scan to see findings here.</div>';
    return;
  }

  list.innerHTML = visible.map((f) => {
    const severity = severityOf(f);
    const level = severity.toLowerCase();
    return `<article class="result ${level}">
      <div class="result-top">
        <div class="result-title">${escapeHtml(f.title)}</div>
        <span class="badge ${level}">${severity}</span>
      </div>
      <p><b>${escapeHtml(f.category)}</b> · ${escapeHtml(f.detail)}</p>
      <code>${escapeHtml(f.selector)}</code>
    </article>`;
  }).join('') + (lockedCount ? lockedCard(lockedCount) : '');
}

/* 5. Views & tabs -------------------------------------------------- */
function updateCrumb() {
  const workspace = state.workspaces.find((w) => String(w.id) === String(state.workspaceId));
  $('#workspaceCrumb').textContent =
    state.view === 'overview' ? workspace?.name || 'Overview' : state.view[0].toUpperCase() + state.view.slice(1);
}

function setView(view) {
  if (!VIEWS.includes(view)) return;
  state.view = view;
  $('#scannerHero').hidden = view !== 'overview';
  VIEWS.forEach((name) => { $(`#${name}View`).hidden = name !== view; });
  $$('[data-view]').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  updateCrumb();
  if (view === 'scans' || view === 'issues') loadSavedScans();
  window.scrollTo({ top: 0 });
}

/* Tablist with arrow-key navigation; onSelect(tab, index) does the work. */
function initTabs(container, onSelect) {
  const tabs = $$('[role="tab"]', container);
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => onSelect(tab, index));
    tab.addEventListener('keydown', (event) => {
      const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      tabs[next].focus();
      onSelect(tabs[next], next);
    });
  });
}

function setScanMode(mode) {
  const isUrl = mode === 'url';
  $('#scanTabUrl').setAttribute('aria-selected', String(isUrl));
  $('#scanTabUrl').tabIndex = isUrl ? 0 : -1;
  $('#scanTabHtml').setAttribute('aria-selected', String(!isUrl));
  $('#scanTabHtml').tabIndex = isUrl ? -1 : 0;
  $('#scanPanelUrl').hidden = !isUrl;
  $('#scanPanelHtml').hidden = isUrl;
}

/* 6. Workspaces & history ------------------------------------------ */
async function loadWorkspaces() {
  const select = $('#workspaceSelect');
  const createButton = $('#newWorkspaceBtn');

  if (!state.account) {
    select.hidden = true;
    createButton.hidden = true;
    return;
  }

  try {
    const { workspaces = [] } = await api('/api/workspaces', { fallback: 'Could not load workspaces.' });
    state.workspaces = workspaces;
    if (!workspaces.some((w) => String(w.id) === String(state.workspaceId))) {
      state.workspaceId = workspaces[0]?.id ?? null;
    }

    select.innerHTML = workspaces
      .map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`)
      .join('');
    if (state.workspaceId !== null) select.value = String(state.workspaceId);
    select.hidden = false;
    createButton.hidden = false;

    $('#workspaceList').innerHTML = workspaces
      .map((w) => `<li>${escapeHtml(w.name)}${String(w.id) === String(state.workspaceId) ? ' <b>(current)</b>' : ''}</li>`)
      .join('') || '<li>No workspaces yet.</li>';

    updateCrumb();
    await loadSavedScans();
  } catch (error) {
    toast(error.message);
  }
}

async function loadSavedScans() {
  if (!state.account || !hasActivePlan() || state.workspaceId === null) {
    state.savedScans = [];
    renderHistory();
    return;
  }
  try {
    const { scans = [] } = await api(`/api/scans?workspaceId=${encodeURIComponent(state.workspaceId)}`, { fallback: 'Could not load scans.' });
    state.savedScans = scans;
    renderHistory();
  } catch (error) {
    $('#scanHistory').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function renderHistory() {
  const history = $('#scanHistory');
  const issues = $('#issueHistory');

  if (!state.savedScans.length) {
    history.innerHTML = '<div class="empty"><strong>No saved scans</strong>Run a scan to start this workspace’s history.</div>';
    issues.innerHTML = '<div class="empty"><strong>No issues yet</strong>Findings from saved scans appear here.</div>';
    return;
  }

  const scanTitle = (scan) => scan.title || scan.url || 'Pasted HTML';

  history.innerHTML = `<div class="history-list">${state.savedScans.map((scan) => `
    <article class="history-row">
      <h3>${escapeHtml(scanTitle(scan))}</h3>
      <p>${scan.scanType === 'url' ? 'URL scan' : 'HTML snippet'} · ${new Date(scan.createdAt).toLocaleString()} · ${plural((scan.findings || []).length, 'finding')}</p>
      ${scan.url ? `<p>${escapeHtml(scan.url)}</p>` : ''}
      <button class="button" type="button" data-open-scan="${escapeHtml(scan.id)}">Open results</button>
    </article>`).join('')}</div>`;

  const allFindings = state.savedScans.flatMap((scan) =>
    (scan.findings || []).map((f) => ({ ...f, scanTitle: scanTitle(scan) })));

  issues.innerHTML = allFindings.length
    ? `<div class="history-list">${allFindings.map((f) => `
      <article class="history-row">
        <h3>${escapeHtml(f.title || 'Accessibility issue')} <span class="badge ${severityOf(f).toLowerCase()}">${severityOf(f)}</span></h3>
        <p>${escapeHtml(f.scanTitle)} · ${escapeHtml(f.category || '')}</p>
        <p>${escapeHtml(f.detail || '')}</p>
        <code>${escapeHtml(f.selector || '')}</code>
      </article>`).join('')}</div>`
    : '<div class="empty"><strong>No issues found</strong>None of the saved scans reported findings.</div>';
}

function openSavedScan(id) {
  const scan = state.savedScans.find((s) => String(s.id) === String(id));
  if (!scan) return;
  applyScan(scan.findings || [], scan.title || scan.url || 'Saved scan');
  setView('overview');
}

async function saveScan(findings) {
  await api('/api/scans', {
    method: 'POST',
    body: { workspaceId: state.workspaceId, findings },
    fallback: 'Could not save this scan.',
  });
  await loadSavedScans();
}

async function createWorkspace(event) {
  event.preventDefault();
  if (!state.account) {
    openAuth('login');
    return;
  }

  const input = $('#workspaceName');
  const name = input.value.trim();
  const status = $('#workspaceStatus');
  try {
    const { workspace } = await api('/api/workspaces', { method: 'POST', body: { name }, fallback: 'Could not create the workspace.' });
    state.workspaceId = workspace.id;
    input.value = '';
    setStatus(status, `Workspace “${name}” created.`, 'success');
    await loadWorkspaces();
    toast('Workspace created.');
  } catch (error) {
    setStatus(status, error.message, 'error');
  }
}

/* 7. Accounts ------------------------------------------------------ */
const hasActivePlan = () => Boolean(state.account?.subscription?.active);

function setAuthMode(mode) {
  const copy = AUTH_COPY[mode];
  state.authMode = mode;
  $('#nameField').hidden = mode !== 'register';
  $('#authName').required = mode === 'register';
  $('#passwordHint').hidden = mode !== 'register';
  $('#authHeading').textContent = copy.heading;
  $('#authIntro').textContent = copy.intro;
  $('#authSubmit').textContent = copy.submit;
  $('#authMode').textContent = copy.switchLabel;
  $('#authPassword').autocomplete = copy.autocomplete;
  $('#authError').textContent = '';
}

function openAuth(mode = 'login', reason) {
  setAuthMode(mode);
  if (reason) $('#authIntro').textContent = reason;
  $('#authDialog').showModal();
  $(mode === 'register' ? '#authName' : '#authEmail').focus();
}

/* Gate for starting a scan: one free anonymous scan, then an account and plan. */
function requireScanAccess() {
  if (!state.account) {
    if (!freeScanUsed()) return true;
    openAuth('register', 'You’ve used your free scan. Create a free account or sign in to keep scanning.');
    return false;
  }
  return requireFullAccess();
}

/* Gate for paid features: scans, saved history and export. */
function requireFullAccess() {
  if (!state.account) {
    openAuth('login');
    return false;
  }
  if (!hasActivePlan()) {
    $('#plansHeading').scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('Choose a plan to unlock this feature.');
    return false;
  }
  if (state.workspaceId === null) {
    toast('Your workspace is still loading. Try again in a moment.');
    loadWorkspaces();
    return false;
  }
  return true;
}

function setAccount(user) {
  state.account = user;
  const accountButton = $('#accountButton');
  const subscription = user?.subscription;

  accountButton.textContent = user ? user.name : 'Sign in';
  accountButton.title = user ? user.email : 'Sign in or create an account';
  $('#logoutButton').hidden = !user;
  $('#cancelPlanBtn').hidden = !(subscription?.active && !subscription.cancelScheduled);

  $('#subscriptionStatus').textContent = !user
    ? 'Sign in to subscribe.'
    : subscription?.active
      ? `${subscription.plan} plan active${subscription.renewsAt ? ` · renews ${new Date(subscription.renewsAt).toLocaleDateString()}` : ''}${subscription.cancelScheduled ? ' · cancellation scheduled' : ''}`
      : 'Signed in · choose a plan to start scanning.';

  $$('[data-plan]').forEach((button) => {
    button.textContent = subscription?.active ? 'Current plan' : `Choose ${PLAN_LABELS[button.dataset.plan]}`;
    if (!user) button.disabled = false;
  });

  renderFreeNote();
  if (state.hasScan) renderResults(); // Reveals or re-locks the preview.

  if (!user) {
    state.workspaces = [];
    state.savedScans = [];
  }
  loadWorkspaces();
}

async function refreshAccount() {
  try {
    const { user } = await api('/api/me');
    setAccount(user || null);
  } catch {
    setAccount(null);
  }
}

async function submitAuth(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const error = $('#authError');
  const submit = $('#authSubmit');
  const unlockingReport = state.hasScan;

  submit.disabled = true;
  error.textContent = '';
  try {
    const { user } = await api(`/api/auth/${state.authMode}`, {
      method: 'POST',
      body: { name: form.get('name'), email: form.get('email'), password: form.get('password') },
      fallback: 'Could not sign in.',
    });
    setAccount(user);
    $('#authDialog').close();
    toast(
      unlockingReport ? 'Signed in. Full report unlocked.'
        : hasActivePlan() ? 'Signed in.'
          : state.authMode === 'register' ? 'Account created. Choose a plan to keep scanning.'
            : 'Signed in. Choose a plan to keep scanning.',
    );
  } catch (err) {
    error.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

async function signOut() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  setAccount(null);
  toast('Signed out.');
}

function showAccountSummary() {
  if (!state.account) {
    openAuth('login');
    return;
  }
  const { name, email, subscription } = state.account;
  toast(`${name} · ${email} · ${subscription?.active ? `${subscription.plan} plan` : 'No active plan'}`);
}

/* 8. Billing ------------------------------------------------------- */
function loadCheckoutScript() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load secure checkout.'));
    document.head.append(script);
  });
}

async function waitForPlanActivation() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await refreshAccount();
    if (hasActivePlan()) return true;
  }
  return false;
}

async function startCheckout(button) {
  if (!state.account) {
    openAuth('register', 'Create a free account to choose a plan.');
    return;
  }
  if (hasActivePlan()) {
    toast('You already have an active plan.');
    return;
  }

  const status = $('#subscriptionStatus');
  button.disabled = true;
  status.textContent = 'Preparing secure checkout…';

  try {
    const order = await api('/api/billing/subscribe', {
      method: 'POST',
      body: { planKey: button.dataset.plan },
      fallback: 'Could not start checkout.',
    });
    await loadCheckoutScript();

    const checkout = new window.Razorpay({
      key: order.keyId,
      subscription_id: order.subscriptionId,
      name: 'AccessKit',
      description: `${order.planName} plan`,
      prefill: { name: state.account.name, email: state.account.email },
      theme: { color: '#0f6b4d' },
      handler: async (payment) => {
        status.textContent = 'Verifying payment…';
        try {
          const result = await api('/api/billing/verify', { method: 'POST', body: payment, fallback: 'Payment verification failed.' });
          status.textContent = result.message;
          if (await waitForPlanActivation()) toast('Your plan is active.');
          else status.textContent = `${result.message} Refresh shortly to check activation.`;
        } catch (error) {
          status.textContent = error.message;
        }
      },
    });
    checkout.on('payment.failed', () => { status.textContent = 'Payment did not complete. You can try again.'; });
    checkout.open();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function cancelPlan() {
  if (!state.account || !hasActivePlan()) return;
  const button = $('#cancelPlanBtn');
  button.disabled = true;
  try {
    const data = await api('/api/billing/cancel', { method: 'POST', fallback: 'Could not schedule cancellation.' });
    setAccount({ ...state.account, subscription: data.subscription });
    $('#subscriptionStatus').textContent = data.message;
  } catch (error) {
    $('#subscriptionStatus').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function loadBillingConfig() {
  try {
    const config = await api('/api/config');
    const incomplete = (config.plans || []).some((plan) => !plan.configured);
    if (!config.razorpayKeyId || incomplete) {
      $('.plan-note').textContent = 'Online checkout is not available yet. Please check back soon.';
    }
  } catch {
    /* Keep the default pricing note. */
  }
}

/* 9. Scanning ------------------------------------------------------ */
function applyScan(findings, label) {
  state.findings = findings;
  state.hasScan = true;
  state.scanLabel = label;
  state.activeTab = 'violations';
  if (!state.account) markFreeScanUsed();
  renderFreeNote();
  renderResults();
}

async function runHtmlScan() {
  if (!requireScanAccess()) return;

  const markup = $('#htmlInput').value.trim();
  if (!markup) {
    toast('Paste some HTML or load the sample first.');
    $('#htmlInput').focus();
    return;
  }

  const button = $('#scanBtn');
  button.disabled = true;
  try {
    const saveable = Boolean(state.account);
    applyScan(scanMarkup(markup), 'Pasted HTML');
    revealResults();
    if (saveable) {
      await saveScan(state.findings);
      toast('Scan complete and saved to this workspace.');
    } else {
      toast('Scan complete. Showing your free preview.');
    }
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function runUrlScan(event) {
  event.preventDefault();
  if (!requireScanAccess()) return;

  const field = $('#urlInput');
  const status = $('#urlStatus');
  const button = $('#urlScanBtn');

  let url;
  try {
    url = new URL(field.value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http or https URL.');
  } catch (error) {
    setStatus(status, error.message === 'Use an http or https URL.' ? error.message : 'Enter a valid public URL.', 'error');
    field.focus();
    return;
  }

  button.disabled = true;
  button.textContent = 'Scanning…';
  setStatus(status, `Scanning ${url.host}…`);

  try {
    const saveable = Boolean(state.account);
    const result = await api('/api/scan', {
      method: 'POST',
      body: { url: url.href, ...(saveable ? { workspaceId: state.workspaceId } : {}) },
      signal: AbortSignal.timeout(30000),
      fallback: 'The scanner returned an error.',
    });
    const host = new URL(result.finalURL || url.href).host;

    applyScan(result.findings || [], result.title || host);
    setStatus(status, `Scan complete: ${result.title || host}.`, 'success');
    revealResults();
    if (saveable) {
      await loadSavedScans();
      toast('Scan complete and saved to this workspace.');
    } else {
      toast('Scan complete. Showing your free preview.');
    }
  } catch (error) {
    const offline = /failed to fetch|networkerror|load failed/i.test(error.message);
    setStatus(
      status,
      error.name === 'TimeoutError' ? 'The scan timed out. Try again, or try a lighter page.'
        : offline ? 'The scanner is unavailable right now. Please try again shortly.'
          : `Scan failed: ${error.message}`,
      'error',
    );
  } finally {
    button.disabled = false;
    button.innerHTML = 'Scan page <span aria-hidden="true">→</span>';
  }
}

function exportReport() {
  if (!requireFullAccess()) return;
  if (!state.findings.length) {
    toast('Run a scan before exporting.');
    return;
  }

  const report = {
    product: 'AccessKit',
    createdAt: new Date().toISOString(),
    notice: 'Heuristic results; not a conformance certification.',
    findings: state.findings,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'accessibility-report.json';
  link.click();
  URL.revokeObjectURL(url);
  toast('Report downloaded.');
}

/* 10. Init --------------------------------------------------------- */
function bindEvents() {
  // Navigation
  $$('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $$('[data-go-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.goView)));
  initTabs($('.scan-tabs'), (tab, index) => setScanMode(index === 0 ? 'url' : 'html'));
  initTabs($('.results-tabs'), (tab) => { state.activeTab = tab.dataset.tab; renderResults(); });

  // Scanning
  $('#urlScanForm').addEventListener('submit', runUrlScan);
  $('#scanBtn').addEventListener('click', runHtmlScan);
  $('#exportBtn').addEventListener('click', exportReport);
  $('#sampleBtn').addEventListener('click', () => {
    $('#htmlInput').value = SAMPLE_HTML;
    toast('Sample loaded. Run the checks to see example results.');
  });
  $('#fileInput').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    $('#htmlInput').value = await file.text();
    toast(`${file.name} loaded.`);
  });

  // Saved scans and workspaces
  $('#scanHistory').addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-scan]');
    if (button) openSavedScan(button.dataset.openScan);
  });
  $('#workspaceSelect').addEventListener('change', (event) => {
    state.workspaceId = event.target.value;
    loadWorkspaces();
  });
  $('#newWorkspaceBtn').addEventListener('click', () => {
    setView('settings');
    $('#workspaceName').focus();
  });
  $('#workspaceForm').addEventListener('submit', createWorkspace);

  // Accounts
  $('#accountButton').addEventListener('click', showAccountSummary);
  $('#logoutButton').addEventListener('click', signOut);
  $('#authClose').addEventListener('click', () => $('#authDialog').close());
  $('#authMode').addEventListener('click', () => setAuthMode(state.authMode === 'login' ? 'register' : 'login'));
  $('#authForm').addEventListener('submit', submitAuth);
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-open-auth]');
    if (trigger) openAuth(trigger.dataset.openAuth, 'Create a free account or sign in to unlock the full report.');
  });

  // Billing
  $$('[data-plan]').forEach((button) => button.addEventListener('click', () => startCheckout(button)));
  $('#cancelPlanBtn').addEventListener('click', cancelPlan);
}

bindEvents();
renderResults();
renderFreeNote();
loadBillingConfig();
refreshAccount();
