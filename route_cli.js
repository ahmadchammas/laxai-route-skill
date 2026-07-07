#!/usr/bin/env node
'use strict';
/*
 * LAXAI route CLI — the pre-flight advisor's data layer.
 * Zero npm deps (Node stdlib only). Lives at <project>/.claude/tools/route_cli.js.
 *
 * Source of truth (all under .claude/skills/route/, override with LAXAI_ROUTE_DIR):
 *   matrix.json         model decision matrix (the operator owns + tunes)
 *   tool-registry.json  tools
 *   recipes.json        task-type recipes (frameworks)
 *   skills.json         skill catalog + keywords + status (auto-synced)
 *   overrides.jsonl     append-only override log
 *   generated/*.md      rendered views, never hand-edited
 *
 * Durability mirrors employees_cli.js: atomic temp-then-rename write, validate-before-write,
 * 5-rotation backups. Render regenerates generated/ FROM the JSON so views never drift.
 *
 * Commands: seed | matrix | tool | recipe | skills | override | plan | render | validate
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./jsonstore.js');

const TOOLS_DIR = __dirname;
const PROJECT_ROOT = path.resolve(TOOLS_DIR, '..', '..');
// DATA dir: explicit override wins; else if the data sits next to this CLI (the global
// install at ~/.claude/skills/route, marked by a co-located SKILL.md) use that; else the
// Productivity-local layout (CLI in .claude/tools, data in .claude/skills/route).
const ROUTE_DIR = process.env.LAXAI_ROUTE_DIR
  ? path.resolve(process.env.LAXAI_ROUTE_DIR)
  : process.env.ROUTE_HOME
    ? path.resolve(process.env.ROUTE_HOME)
    : (fs.existsSync(path.join(__dirname, 'SKILL.md'))
        ? __dirname
        : path.join(PROJECT_ROOT, '.claude', 'skills', 'route'));
const GEN_DIR = path.join(ROUTE_DIR, 'generated');
const TEMPLATES_DIR = path.join(ROUTE_DIR, 'templates');
// REVIEWS dir follows the PROJECT YOU ARE IN (cwd), so external tools write into that
// project's reviews/ folder, not wherever route_cli happens to live. Override with LAXAI_REVIEWS_DIR.
const REVIEWS_DIR = process.env.LAXAI_REVIEWS_DIR ? path.resolve(process.env.LAXAI_REVIEWS_DIR) : path.join(process.cwd(), 'reviews');
const BACKUP_DIR = path.join(ROUTE_DIR, '.backups');
const SCHEMA_VERSION = 1;
const BACKUP_ROTATIONS = 5;

// ---- operator layer (per-project): profile.json, runs/, overrides.jsonl ----
// Resolved by ROUTE_PROJECT_DIR override (tests) or by walking up from cwd to the
// nearest .claude/. project_root is pinned so every run/handoff echoes an absolute root.
function resolveOperator() {
  if (process.env.ROUTE_PROJECT_DIR) {
    const opDir = path.resolve(process.env.ROUTE_PROJECT_DIR);
    let root;
    if (process.env.ROUTE_PROJECT_ROOT) root = path.resolve(process.env.ROUTE_PROJECT_ROOT);
    else if (path.basename(opDir) === 'operator' && path.basename(path.dirname(opDir)) === '.claude') root = path.dirname(path.dirname(opDir));
    else root = opDir;
    return { opDir, root };
  }
  let d = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(d, '.claude'))) return { opDir: path.join(d, '.claude', 'operator'), root: d };
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return { opDir: path.join(process.cwd(), '.claude', 'operator'), root: process.cwd() };
}
const _OP = resolveOperator();
const OPERATOR_DIR = _OP.opDir;
const RESOLVED_ROOT = _OP.root;
const RUNS_DIR = path.join(OPERATOR_DIR, 'runs');

// ---------- args (mirrors employees_cli.js:94-115) ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else { const k = a.slice(2); const n = argv[i + 1]; if (n !== undefined && !n.startsWith('--')) { out[k] = n; i++; } else out[k] = true; }
    } else out._.push(a);
  }
  return out;
}
function pick(args, ...names) { for (const n of names) { if (args[n] !== undefined) return args[n]; const alt = n.includes('_') ? n.replace(/_/g, '-') : n.replace(/-/g, '_'); if (args[alt] !== undefined) return args[alt]; } return undefined; }
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function listArg(v) { return v === undefined ? undefined : String(v).split(',').map(s => s.trim()).filter(Boolean); }

// ---------- time / fs / durability ----------
function pad(n) { return String(n).padStart(2, '0'); }
function nowIso(d) { d = d || new Date(); const off = -d.getTimezoneOffset(); const s = off >= 0 ? '+' : '-'; return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${s}${pad(Math.floor(Math.abs(off)/60))}:${pad(Math.abs(off)%60)}`; }
function dateStr(d) { d = d || new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function readJSONFile(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
function writeJSONAtomic(file, obj) {
  ensureDir(path.dirname(file));
  if (fs.existsSync(file)) { // backup with rotation
    ensureDir(BACKUP_DIR);
    const base = path.basename(file);
    for (let i = BACKUP_ROTATIONS - 1; i >= 1; i--) {
      const a = path.join(BACKUP_DIR, `${base}.${i}`), b = path.join(BACKUP_DIR, `${base}.${i + 1}`);
      if (fs.existsSync(a)) fs.copyFileSync(a, b);
    }
    fs.copyFileSync(file, path.join(BACKUP_DIR, `${base}.1`));
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function writeText(file, text) { ensureDir(path.dirname(file)); const tmp = file + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
function die(msg) { process.stderr.write(msg + '\n'); process.exit(1); }

// ---------- defaults ----------
function defaultMatrix() {
  return { schema_version: SCHEMA_VERSION, last_modified: nowIso(), rows: [
    { id: 'bulk-read',   task: 'Bulk reading, summarizing, mechanical text',                           model: 'haiku-4-5',  effort: 'normal', why: 'fast, cheap, no reasoning' },
    { id: 'daily-ops',   task: 'Daily ops (start-day, board, status)',                                  model: 'sonnet-4-6', effort: 'normal', why: 'standing rule: daily ops on Sonnet' },
    { id: 'single-file', task: 'Single-file change, standard fix, bulk drafting',                       model: 'sonnet-4-6', effort: 'normal', why: 'balanced' },
    { id: 'multi-file',  task: 'Multi-file feature, moderate complexity',                               model: 'opus-4-8',   effort: 'high',   why: 'cross-file judgment' },
    { id: 'writing',     task: 'Writing in your voice (posts, chapters)',                               model: 'opus-4-8',   effort: 'high',   why: 'voice quality' },
    { id: 'architecture',task: 'Architecture, hard debugging, orchestration, decision from reports',    model: 'opus-4-8',   effort: 'max',    why: 'a wrong call costs more than tokens' },
    { id: 'wide-context',task: 'Cross-file scan over ~100k tokens',                                     model: 'gemini-pro', effort: 'n/a',    why: '1M context is the edge' },
    { id: 'cheap-audit', task: 'Cheap analytical audit, bug-pattern scan',                              model: 'deepseek',   effort: 'n/a',    why: 'low cost, strong analytical read' },
  ] };
}
function defaultTools() {
  return { schema_version: SCHEMA_VERSION, last_modified: nowIso(), tools: [
    { id: 'claude-code',   use: 'orchestration, the only writer to the main dir', status: 'internal' },
    { id: 'context-mode',  use: 'sandbox compute so raw bytes stay out of context', status: 'active' },
    { id: 'claude-mem',    use: 'cross-session memory', status: 'active' },
    { id: 'google-drive',  use: 'read docs and reference sheets', status: 'active' },
    { id: 'google-calendar', use: 'schedule direct activities (writes confirm)', status: 'active' },
    { id: 'github',        use: 'repo and PR operations', status: 'active' },
    { id: 'gemini-pro',    use: 'wide cross-file review (Antigravity)', status: 'external' },
    { id: 'deepseek',      use: 'deep local audit (Roo Code)', status: 'external' },
    { id: 'framer-motion', use: 'web animation, UI motion', status: 'active' },
    { id: 'rabbit',        use: 'bug and layout detection (CodeRabbit)', status: 'active' },
    { id: 'xui-pro-max',   use: 'UI design system', status: 'active' },
    { id: 'composio',      use: 'WhatsApp / LinkedIn connectors', status: 'deferred' },
  ] };
}
function defaultRecipes() {
  return { schema_version: SCHEMA_VERSION, last_modified: nowIso(), recipes: [
    { id: 'feature-build', name: 'Build a software feature', keywords: ['feature','build','code','implement','function','module','bug','fix','backend','api'],
      model: 'opus-4-8', effort: 'high', skills: ['test-driven-development','systematic-debugging'], tools: ['deepseek','gemini-pro'],
      chain: [{ step: 'plan', who: 'opus-4-8/high' }, { step: 'build', who: 'opus-4-8/high', writes: true }, { step: 'deep audit', who: 'external:deepseek', your_step: true, template: 'deepseek-deep' }, { step: 'wide check', who: 'external:gemini', your_step: true, template: 'gemini-wide' }, { step: 'decide + fix', who: 'opus-4-8/high' }],
      review_checklist: ['no logic errors in changed files', 'edge cases handled', 'no broken callers elsewhere'], external_prompts: ['deepseek-deep','gemini-wide'] },
    { id: 'site-build', name: 'Build or redesign a site / UI', keywords: ['site','ui','ux','redesign','landing','dashboard','page','component','frontend','css','layout','design'],
      model: 'opus-4-8', effort: 'high', skills: ['ui-ux-pro-max','frontend-design'], tools: ['framer-motion','rabbit','gemini-pro'],
      chain: [{ step: 'plan the UI', who: 'sonnet-4-6+ui-ux-pro-max (subagent)', reports_to: 'opus' }, { step: 'build', who: 'opus-4-8/high', writes: true }, { step: 'bug scan', who: 'external:rabbit', your_step: true, template: 'rabbit-scan' }, { step: 'cross-file check', who: 'external:gemini', your_step: true, template: 'gemini-wide' }, { step: 'decide + fix', who: 'opus-4-8/high' }],
      review_checklist: ['responsive at mobile/tablet/desktop', 'no duplicated component logic', 'matches the design system'], external_prompts: ['gemini-wide'] },
    { id: 'code-review', name: 'Code review / bug hunt', keywords: ['review','audit','bug','hunt','quality','lint','security','smell','regression'],
      model: 'opus-4-8', effort: 'high', skills: ['code-review','critique'], tools: ['deepseek','gemini-pro'],
      chain: [{ step: 'deep local scan', who: 'external:deepseek', your_step: true, template: 'deepseek-deep' }, { step: 'wide cross-file scan', who: 'external:gemini', your_step: true, template: 'gemini-wide' }, { step: 'decide + fix', who: 'opus-4-8/high' }],
      review_checklist: ['correctness bugs', 'cross-file consistency', 'duplicated logic'], external_prompts: ['deepseek-deep','gemini-wide'] },
    { id: 'write-in-your-voice', name: 'Write in your voice (posts, chapters)', keywords: ['write','post','article','chapter','blog','quora','medium','substack','draft','voice','essay'],
      model: 'opus-4-8', effort: 'high', skills: ['writing-style','humanizer'], tools: [],
      chain: [{ step: 'draft', who: 'opus-4-8/high', writes: true }, { step: 'self-edit to voice', who: 'opus-4-8/high' }], review_checklist: ['plain, no AI tells', 'sounds like you, not the model'], external_prompts: [] },
    { id: 'problem-solve', name: 'Critical-thinking / problem framing', keywords: ['problem','decide','decision','strategy','think','framework','tradeoff','option','why','root','cause'],
      model: 'opus-4-8', effort: 'max', skills: ['critique','team','decision-logger','deep-research'], tools: [],
      chain: [{ step: 'frame the problem', who: 'opus-4-8/max' }, { step: 'pressure-test (critique + team)', who: 'opus-4-8/max' }, { step: 'research if facts missing', who: 'opus-4-8/high' }, { step: 'recommend + log', who: 'opus-4-8/max' }],
      review_checklist: ['problem stated cleanly', 'options with trade-offs', 'recommendation marked'], external_prompts: [] },
    { id: 'research', name: 'Research a topic / market / leads', keywords: ['research','market','lead','topic','sources','investigate','compare','landscape','competitor'],
      model: 'opus-4-8', effort: 'high', skills: ['deep-research','firecrawl'], tools: ['gemini-pro'],
      chain: [{ step: 'fan-out search', who: 'opus-4-8/high' }, { step: 'wide synthesis', who: 'gemini-pro' }, { step: 'cite + report', who: 'opus-4-8/high', writes: true }], review_checklist: ['claims sourced', 'no unverified assertion'], external_prompts: [] },
    { id: 'plan-scope', name: 'Plan / scope a project or feature', keywords: ['plan','scope','spec','design','brainstorm','kickoff','architecture','blueprint'],
      model: 'opus-4-8', effort: 'high', skills: ['brainstorming','grill-me','writing-plans','critique'], tools: [],
      chain: [{ step: 'brainstorm', who: 'opus-4-8/high' }, { step: 'critique', who: 'opus-4-8/high' }, { step: 'write plan', who: 'opus-4-8/high', writes: true }], review_checklist: ['no placeholders', 'tasks are bite-sized'], external_prompts: [] },
    { id: 'data-analysis', name: 'Analyze data / spreadsheets', keywords: ['data','spreadsheet','xlsx','csv','sheet','finance','numbers','aggregate','chart','analysis'],
      model: 'sonnet-4-6', effort: 'normal', skills: ['xlsx'], tools: ['context-mode'],
      chain: [{ step: 'compute in sandbox', who: 'sonnet-4-6/normal' }, { step: 'report the answer', who: 'sonnet-4-6/normal', writes: true }], review_checklist: ['math checks out', 'raw rows kept out of context'], external_prompts: [] },
    { id: 'daily-ops', name: 'Daily ops / routine', keywords: ['start','day','board','status','reconcile','routine','standup','checkin','handoff'],
      model: 'sonnet-4-6', effort: 'normal', skills: ['task-management'], tools: [],
      chain: [{ step: 'run the routine', who: 'sonnet-4-6/normal' }], review_checklist: ['board reconciled', 'nothing stale'], external_prompts: [] },
    { id: 'strategy-scan', name: 'Portfolio / strategy scan', keywords: ['strategy','portfolio','scan','quarterly','priorities','workstreams','master plan','across projects'],
      model: 'opus-4-8', effort: 'max', skills: ['fleet','insights'], tools: [],
      chain: [{ step: 'digest state', who: 'haiku-4-5/normal' }, { step: 'sweep boards+handoffs read-only', who: 'fleet-scout' }, { step: 'synthesize + rank', who: 'opus-4-8/max' }, { step: 'decide with the operator (options)', who: 'operator' }],
      review_checklist: ['every claim traceable to a board/handoff file', 'highest-priority lane ranked first', 'no new scheduled loops proposed while a blocking dependency is open'], external_prompts: [] },
  ] };
}

// ---------- validators ----------
function validateMatrix(m) { if (!m || !Array.isArray(m.rows)) throw new Error('matrix.rows missing'); for (const r of m.rows) if (!r.id || !r.model) throw new Error('matrix row needs id+model'); }
function validateTools(t) { if (!t || !Array.isArray(t.tools)) throw new Error('tool-registry.tools missing'); for (const x of t.tools) if (!x.id || !x.status) throw new Error('tool needs id+status'); }
function validateRecipes(rc) { if (!rc || !Array.isArray(rc.recipes)) throw new Error('recipes.recipes missing'); for (const x of rc.recipes) { if (!x.id || !x.name) throw new Error('recipe needs id+name'); if (!Array.isArray(x.keywords) || !x.keywords.length) throw new Error(`recipe ${x.id} needs keywords`); } }

// ---------- command table ----------
const COMMANDS = {};

COMMANDS.seed = function () {
  const M = path.join(ROUTE_DIR, 'matrix.json'), T = path.join(ROUTE_DIR, 'tool-registry.json'), R = path.join(ROUTE_DIR, 'recipes.json');
  if (!fs.existsSync(M)) writeJSONAtomic(M, defaultMatrix());
  if (!fs.existsSync(T)) writeJSONAtomic(T, defaultTools());
  if (!fs.existsSync(R)) writeJSONAtomic(R, defaultRecipes());
  const P = path.join(ROUTE_DIR, 'prompt-templates.json');
  if (!fs.existsSync(P)) writeJSONAtomic(P, defaultTemplates());
  console.log('seeded matrix.json, tool-registry.json, recipes.json, prompt-templates.json (existing files left intact)');
};
COMMANDS.validate = function () {
  const M = readJSONFile(path.join(ROUTE_DIR, 'matrix.json'));
  const T = readJSONFile(path.join(ROUTE_DIR, 'tool-registry.json'));
  const R = readJSONFile(path.join(ROUTE_DIR, 'recipes.json'));
  const P = readJSONFile(path.join(ROUTE_DIR, 'prompt-templates.json'));
  const models = readJSONFile(path.join(ROUTE_DIR, 'models.json'));
  try { if (M) validateMatrix(M); if (T) validateTools(T); if (R) validateRecipes(R); if (P) validateTemplates(P); }
  catch (e) { die('validate FAILED: ' + e.message); }
  // engine-core checks (only once models.json is installed, so validate stays green mid-build)
  if (models) {
    if (!models.models || !models.ladder) die('validate FAILED: models.json needs models + ladder');
    const need = ['brief.md', 'read-report.md', 'handoff-build.md', 'handoff-verify.md', 'handoff-critique.md', 'close.md'];
    const missing = need.filter(f => !fs.existsSync(path.join(TEMPLATES_DIR, f)));
    if (missing.length) die('validate FAILED: missing engine templates: ' + missing.join(', '));
    // template lint (prompt-standard.md §8): every STAGE-HANDOFF template must carry all four —
    // the role line, the pinned project_root, a Rules block, and the report contract.
    for (const f of ['handoff-build.md', 'handoff-verify.md', 'handoff-critique.md']) {
      const txt = fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8');
      if (!/You are/.test(txt)) die(`validate FAILED: ${f} missing the role line (You are the <stage> stage...)`);
      if (!txt.includes('{{project_root}}')) die(`validate FAILED: ${f} missing {{project_root}} (context-drift guard)`);
      if (!/Rules/.test(txt)) die(`validate FAILED: ${f} missing a Rules block`);
      if (!/OUTCOME/.test(txt)) die(`validate FAILED: ${f} missing the report contract (OUTCOME...)`);
    }
    try { store.ensureDir(RUNS_DIR); const t = path.join(RUNS_DIR, '.wtest'); fs.writeFileSync(t, 'ok'); fs.unlinkSync(t); }
    catch (e) { die('validate FAILED: runs dir not writable: ' + RUNS_DIR); }
  }
  console.log('validate ok');
};

function loadOrDie(name, validator) { const p = path.join(ROUTE_DIR, name); const o = readJSONFile(p); if (!o) die(`${name} missing — run: route_cli seed`); try { validator(o); } catch (e) { die(`${name} invalid: ${e.message}`); } return o; }

COMMANDS.matrix = function (args) {
  const sub = args._[0];
  const m = loadOrDie('matrix.json', validateMatrix);
  if (sub === 'get') { const id = pick(args, 'id'); const row = m.rows.find(x => x.id === id); if (!row) die(`no matrix row ${id}`); console.log(`${row.id}: ${row.model} / ${row.effort} — ${row.why}`); return; }
  if (sub === 'set') { const id = pick(args, 'id'); const row = m.rows.find(x => x.id === id); if (!row) die(`no matrix row ${id}`); const model = pick(args, 'model'), effort = pick(args, 'effort'), why = pick(args, 'why'); if (typeof model === 'string') row.model = model; if (typeof effort === 'string') row.effort = effort; if (typeof why === 'string') row.why = why; m.last_modified = nowIso(); writeJSONAtomic(path.join(ROUTE_DIR, 'matrix.json'), m); console.log(`updated ${id}`); return; }
  die('matrix: use get|set');
};
COMMANDS.tool = function (args) {
  const sub = args._[0];
  const t = loadOrDie('tool-registry.json', validateTools);
  if (sub === 'list') { for (const x of t.tools) console.log(`${x.id} [${x.status}] — ${x.use}`); return; }
  if (sub === 'add') { const id = pick(args, 'id'); if (typeof id !== 'string') die('tool add needs --id=<value>'); if (t.tools.find(x => x.id === id)) die(`tool ${id} exists`); t.tools.push({ id, use: pick(args, 'use') || '', status: pick(args, 'status') || 'candidate' }); t.last_modified = nowIso(); writeJSONAtomic(path.join(ROUTE_DIR, 'tool-registry.json'), t); console.log(`added ${id}`); return; }
  if (sub === 'deprecate') { const id = pick(args, 'id'); if (!id) die('tool deprecate needs --id'); const x = t.tools.find(y => y.id === id); if (!x) die(`no tool ${id}`); x.status = 'deprecated'; t.last_modified = nowIso(); writeJSONAtomic(path.join(ROUTE_DIR, 'tool-registry.json'), t); console.log(`deprecated ${id}`); return; }
  die('tool: use list|add|deprecate');
};

COMMANDS.recipe = function (args) {
  const sub = args._[0];
  const R = loadOrDie('recipes.json', validateRecipes);
  if (sub === 'list') { for (const x of R.recipes) console.log(`${x.id} — ${x.name} [${x.model}/${x.effort}]`); return; }
  if (sub === 'get') { const id = pick(args, 'id'); const x = R.recipes.find(y => y.id === id); if (!x) die(`no recipe ${id}`); console.log(JSON.stringify(x, null, 2)); return; }
  if (sub === 'add') {
    const id = slug(pick(args, 'id')); if (!id) die('recipe add needs --id');
    if (R.recipes.find(x => x.id === id)) die(`recipe ${id} exists`);
    const keywords = listArg(pick(args, 'keywords')) || []; if (!keywords.length) die('recipe add needs --keywords (comma-separated)');
    const rec = { id, name: pick(args, 'name') || id, keywords, model: pick(args, 'model') || 'opus-4-8', effort: pick(args, 'effort') || 'high', skills: listArg(pick(args, 'skills')) || [], tools: listArg(pick(args, 'tools')) || [], chain: [], review_checklist: [], external_prompts: [] };
    R.recipes.push(rec); R.last_modified = nowIso(); writeJSONAtomic(path.join(ROUTE_DIR, 'recipes.json'), R); console.log(`added recipe ${id}`); return;
  }
  if (sub === 'validate') { try { validateRecipes(R); } catch (e) { die(e.message); } console.log('recipes ok'); return; }
  die('recipe: use list|get|add|validate');
};

function tokenize(text) { return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []; }
function stem(t) { t = String(t); const s = t.replace(/(ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1'); return s.length >= 3 ? s : t; }
function scoreRecipe(taskTokens, recipe, taskLow) {
  const set = new Set(taskTokens); let s = 0;
  for (const k of recipe.keywords) {
    const kl = String(k).toLowerCase();
    // A multi-word keyword ("master plan", "across projects") can never be in a single-word token
    // set — match it as a phrase substring, or purpose-built recipes (strategy-scan) never fire and
    // get shadowed by a single-word collision (problem-solve on "strategy"). 2026-07-03 efficiency scan.
    if (kl.includes(' ')) { if (kl.split(/\s+/).every(w => set.has(w))) s++; }  // all words present (order/filler-insensitive)
    else if (set.has(kl)) s++;
  }
  return s;
}
function matchRecipe(task, recipes) {
  const toks = tokenize(task); const low = String(task || '').toLowerCase(); let best = null, bestScore = 0;
  for (const r of recipes) { const s = scoreRecipe(toks, r, low); if (s > bestScore) { bestScore = s; best = r; } }
  return bestScore > 0 ? best : null;
}
function renderFlightPlan(recipe, task) {
  const lines = [];
  lines.push(`FLIGHT PLAN · ${task}   [recipe: ${recipe.id}]`);
  lines.push('');
  const yourSteps = [];
  recipe.chain.forEach((step, i) => {
    const n = i + 1;
    let tail = step.your_step ? '  [YOUR STEP]' : '';
    if (step.reports_to) tail += `  -> reports to ${step.reports_to}`;
    if (step.template) tail += `  -> prompt: ${step.template}`;
    lines.push(`${n}. ${step.step} -> ${step.who}${tail}`);
    if (step.your_step) yourSteps.push(n);
  });
  if (recipe.skills.length) lines.push('', `skills: ${recipe.skills.join(', ')}`);
  if (recipe.tools.length) lines.push(`tools: ${recipe.tools.join(', ')}`);
  // ladder fallback order footer (P3.3 acceptance): a down model degrades the run, never stalls it
  const ladderParts = [];
  for (const role of ['reason', 'execute', 'review', 'digest']) {
    const { model, fallbacks } = resolveLadder(role);
    if (model) ladderParts.push(`${role} ${model}` + (fallbacks.length ? ` -> ${fallbacks.join(' -> ')}` : ''));
  }
  if (ladderParts.length) lines.push('', `fallback order: ${ladderParts.join(' · ')}`);
  if (yourSteps.length) lines.push('', `your steps: ${yourSteps.join(', ')}. I'll hand you each external prompt when you reach it.`);
  return lines.join('\n');
}
COMMANDS.plan = function (args) {
  const task = args._.join(' ').trim() || pick(args, 'task') || '';
  if (!task) die('plan needs a task description');
  const R = loadOrDie('recipes.json', validateRecipes);
  const recipe = matchRecipe(task, R.recipes);
  if (!recipe) { console.log(`no recipe matched "${task}". Plan fresh from the matrix, or author one with route recipe new.`); return; }
  console.log(renderFlightPlan(recipe, task));
};

const STOPWORDS = new Set(['the','a','an','and','or','of','for','to','in','on','with','that','this','use','when','user','users','it','is','are','your','you','any','from','into','via','as','by','at','be','can','not','no','do','does','also','etc']);
function extractKeywords(text, max) {
  max = max || 12;
  const seen = new Set(), out = [];
  for (const w of tokenize(text)) { if (w.length < 3 || STOPWORDS.has(w) || seen.has(w)) continue; seen.add(w); out.push(w); if (out.length >= max) break; }
  return out;
}
function loadSkills() { const p = path.join(ROUTE_DIR, 'skills.json'); return readJSONFile(p) || { schema_version: SCHEMA_VERSION, last_modified: nowIso(), skills: [] }; }
const VALID_SKILL_STATUS = ['keep', 'candidate', 'unused', 'want'];
function skillsAudit(args) {
  const S = loadSkills();
  const name = pick(args, 'name'), status = pick(args, 'status');
  if (!name && !status) { // list mode
    const by = {}; for (const s of S.skills) { (by[s.status] = by[s.status] || []).push(s.name); }
    for (const st of VALID_SKILL_STATUS) if (by[st]) console.log(`${st}: ${by[st].join(', ')}`);
    return;
  }
  if (!VALID_SKILL_STATUS.includes(status)) die(`status must be one of: ${VALID_SKILL_STATUS.join(', ')}`);
  const s = S.skills.find(x => x.name === name); if (!s) die(`no skill ${name}`);
  s.status = status; S.last_modified = nowIso(); writeJSONAtomic(path.join(ROUTE_DIR, 'skills.json'), S);
  console.log(`${name} -> ${status}`);
}
// ---- skill lint helpers (P4): resolve a skill name to its SKILL.md, run structural checks ----
// Mirrors builder/tools/quality_gate.sh (trigger, named steps, output/artifact) and adds the two
// skill-standard extras (anti-triggers present, checklist present). Read-only: never edits a SKILL.md.
function skillPathIndex() {
  const idx = {};
  const add = (name, p) => { if (name && !idx[name] && fs.existsSync(p)) idx[name] = p; };
  const scanSkillsDir = (dir) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) if (e.isDirectory()) add(e.name, path.join(dir, e.name, 'SKILL.md'));
  };
  const home = require('os').homedir();
  scanSkillsDir(path.join(home, '.claude', 'skills'));          // global skills (route lives here)
  let d = process.cwd();                                        // project skills: bounded walk-up to nearest .claude
  for (let i = 0; i < 8; i++) { scanSkillsDir(path.join(d, '.claude', 'skills')); const parent = path.dirname(d); if (parent === d) break; d = parent; }
  const walk = (dir, depth) => {                                // plugin skills (marketplace cache)
    if (depth > 7) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) { if (!e.isDirectory()) continue; const full = path.join(dir, e.name); if (e.name === 'skills') scanSkillsDir(full); else walk(full, depth + 1); }
  };
  walk(path.join(home, '.claude', 'plugins', 'cache'), 0);
  return idx;
}
function lintSkillFile(p) {
  const txt = fs.readFileSync(p, 'utf8');
  const nonStructural = txt.split('\n').filter(l => !/^(name:|#+\s|description:)/.test(l)).join('\n');
  const checks = {
    trigger: /(use when|use at|trigger|when to use|invoke when|use on)/i.test(txt),
    steps: /^#{2,3}\s+/m.test(txt) || /^\s*\d+[.)]\s+/m.test(txt),
    output: /(\boutput\b|\bartifact\b|\bproduces\b|\bresult\b|\breturns\b|\bwrites\b|\bgenerates\b|\bemits\b|\bdelivers\b|\breport\b|\brenders?\b)/i.test(nonStructural),
    anti_triggers: /(anti-?trigger|do not use|don'?t use|not for|skip:|do not trigger|don'?t trigger|avoid when|when not to use|do not trigger)/i.test(txt),
    checklist: /checklist/i.test(txt) || /^\s*[-*]\s+\[[ xX]\]/m.test(txt),
  };
  const failed = Object.keys(checks).filter(k => !checks[k]);
  return { pass: failed.length === 0, failed };
}
COMMANDS.skills = function (args) {
  const sub = args._[0];
  if (sub === 'sync') {
    const adds = []; const raw = pick(args, 'add');
    if (raw) (Array.isArray(raw) ? raw : [raw]).forEach(s => adds.push(s));
    const S = loadSkills(); let added = 0;
    for (const spec of adds) {
      if (typeof spec !== 'string') continue;
      const [name, scope, desc] = spec.split('|').map(x => (x || '').trim());
      if (!name) continue;
      if (S.skills.find(x => x.name === name)) continue; // idempotent
      S.skills.push({ name, scope: scope || 'unknown', desc: desc || '', keywords: Array.from(new Set([...tokenize(name), ...extractKeywords(desc || name)])).slice(0, 14), status: 'candidate', used_by: [] });
      added++;
    }
    S.last_modified = nowIso(); writeJSONAtomic(path.join(ROUTE_DIR, 'skills.json'), S);
    console.log(`skills sync: added ${added}, total ${S.skills.length}`); return;
  }
  if (sub === 'suggest') {
    const task = args._.slice(1).join(' ').trim() || pick(args, 'task') || '';
    const toks = new Set(tokenize(task).map(stem)); const S = loadSkills();
    const scored = S.skills.map(s => { const terms = new Set([...(s.keywords || []), ...tokenize(s.name)].map(stem)); let n = 0; for (const t of terms) if (toks.has(t)) n++; return { s, n }; }).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 5);
    if (!scored.length) { console.log('no skill matched'); return; }
    for (const x of scored) console.log(`${x.s.name} [${x.s.scope}/${x.s.status}] (${x.n}) — ${x.s.desc}`); return;
  }
  if (sub === 'audit') { return skillsAudit(args); } // Task 7

  // ---- skills set --name <skill> --category <cat> ----
  // Writes/updates the "category" string field on a skill entry. Idempotent.
  if (sub === 'set') {
    const name = pick(args, 'name'); if (typeof name !== 'string' || !name) die('skills set needs --name=<skill>');
    const category = pick(args, 'category'); if (typeof category !== 'string' || !category) die('skills set needs --category=<cat>');
    const S = loadSkills();
    const skill = S.skills.find(x => x.name === name);
    if (!skill) die(`skills set: no skill named "${name}" — run: route_cli skills sync to add it first`);
    const prev = skill.category;
    skill.category = category;
    skill.last_modified = nowIso(); // field-level timestamp for traceability
    S.last_modified = nowIso();
    writeJSONAtomic(path.join(ROUTE_DIR, 'skills.json'), S);
    if (prev !== undefined && prev !== category) {
      console.log(`${name}.category: "${prev}" -> "${category}"`);
    } else if (prev === category) {
      console.log(`${name}.category already "${category}" (no change)`);
    } else {
      console.log(`${name}.category = "${category}"`);
    }
    return;
  }

  // ---- skills wire --name <skill> --agent <agentId> ----
  // Appends agentId to the skill's "used_by" array, de-duplicated. Idempotent.
  if (sub === 'wire') {
    const name = pick(args, 'name'); if (typeof name !== 'string' || !name) die('skills wire needs --name=<skill>');
    const agent = pick(args, 'agent'); if (typeof agent !== 'string' || !agent) die('skills wire needs --agent=<agentId>');
    const S = loadSkills();
    const skill = S.skills.find(x => x.name === name);
    if (!skill) die(`skills wire: no skill named "${name}" — run: route_cli skills sync to add it first`);
    if (!Array.isArray(skill.used_by)) skill.used_by = [];
    if (skill.used_by.includes(agent)) {
      console.log(`${name}.used_by already contains "${agent}" (no change)`);
      return;
    }
    skill.used_by.push(agent);
    skill.last_modified = nowIso();
    S.last_modified = nowIso();
    writeJSONAtomic(path.join(ROUTE_DIR, 'skills.json'), S);
    console.log(`${name}.used_by += "${agent}" (total: ${skill.used_by.join(', ')})`);
    return;
  }

  // ---- skills unwire --name <skill> --agent <agentId> ----
  // Removes agentId from the skill's used_by (inverse of wire, one writer stays route_cli). Idempotent.
  if (sub === 'unwire') {
    const name = pick(args, 'name'); if (typeof name !== 'string' || !name) die('skills unwire needs --name=<skill>');
    const agent = pick(args, 'agent'); if (typeof agent !== 'string' || !agent) die('skills unwire needs --agent=<agentId>');
    const S = loadSkills();
    const skill = S.skills.find(x => x.name === name);
    if (!skill) die(`skills unwire: no skill named "${name}"`);
    if (!Array.isArray(skill.used_by) || !skill.used_by.includes(agent)) { console.log(`${name}.used_by does not contain "${agent}" (no change)`); return; }
    skill.used_by = skill.used_by.filter(a => a !== agent);
    skill.last_modified = nowIso();
    S.last_modified = nowIso();
    writeJSONAtomic(path.join(ROUTE_DIR, 'skills.json'), S);
    console.log(`${name}.used_by -= "${agent}" (remaining: ${skill.used_by.join(', ') || 'none'})`);
    return;
  }

  // ---- skills migrate: add the `lint` field (default n/a) + bump the catalog schema (P4.1) ----
  if (sub === 'migrate') {
    const S = loadSkills();
    let touched = 0;
    for (const s of S.skills) { if (!('lint' in s)) { s.lint = 'n/a'; touched++; } }
    S.schema_version = 2;
    S.last_modified = nowIso();
    writeJSONAtomic(path.join(ROUTE_DIR, 'skills.json'), S);
    console.log(`skills migrate: schema_version -> 2, lint defaulted on ${touched} entr${touched === 1 ? 'y' : 'ies'} (total ${S.skills.length})`);
    return;
  }

  // ---- skills lint [--name <skill> | --all]: structural quality gate, writes the lint field (P4.3) ----
  // Wraps quality_gate.sh's three checks + skill-standard's two extras. Does NOT auto-edit any SKILL.md;
  // failures are a worklist for /skill-forge. n/a = SKILL.md not resolvable from the search roots.
  if (sub === 'lint') {
    const S = loadSkills();
    const only = pick(args, 'name');
    const idx = skillPathIndex();
    const targets = only ? S.skills.filter(s => s.name === only) : S.skills;
    if (only && !targets.length) die(`skills lint: no skill named "${only}"`);
    const results = [];
    for (const s of targets) {
      const p = idx[s.name];
      if (!p) { s.lint = 'n/a'; results.push({ name: s.name, lint: 'n/a', failed: [] }); continue; }
      const r = lintSkillFile(p);
      s.lint = r.pass ? 'pass' : 'fail';
      results.push({ name: s.name, lint: s.lint, failed: r.failed });
    }
    if (!('schema_version' in S) || S.schema_version < 2) S.schema_version = 2;
    S.last_modified = nowIso();
    writeJSONAtomic(path.join(ROUTE_DIR, 'skills.json'), S);
    const pass = results.filter(r => r.lint === 'pass'), fail = results.filter(r => r.lint === 'fail'), na = results.filter(r => r.lint === 'n/a');
    console.log(`skills lint: ${pass.length} pass, ${fail.length} fail, ${na.length} n/a (of ${results.length})`);
    for (const r of fail) console.log(`  FAIL ${r.name} — missing: ${r.failed.join(', ')}`);
    if (only && na.length) for (const r of na) console.log(`  n/a  ${r.name} (SKILL.md not found in search roots)`);
    return;
  }

  die('skills: use sync|suggest|audit|set|wire|unwire|migrate|lint\n' +
      '  skills set    --name <skill> --category <cat>   write/update the category field\n' +
      '  skills wire   --name <skill> --agent <agentId>  append agent to used_by (deduped)\n' +
      '  skills unwire --name <skill> --agent <agentId>  remove agent from used_by\n' +
      '  skills migrate                                 add lint field (n/a) + bump schema to 2\n' +
      '  skills lint  [--name <skill> | --all]          structural quality gate, writes lint field');
};

COMMANDS.override = function (args) {
  const task = args._.join(' ').trim() || pick(args, 'task') || '';
  const chosen = pick(args, 'chosen') || '';
  // An override row without a task and a chosen value is unusable at the token review — reject it
  // like every other verb rejects bad args (2026-07-03 wiring-scan fix; empty rows were logged silently).
  if (!task) die('override needs a task: route_cli override "<task>" --chosen=<what was chosen> [--recommended=... --why=...]');
  if (typeof chosen !== 'string' || !chosen) die('override needs --chosen=<what was chosen instead of the recommendation>');
  const entry = { date: dateStr(), task, recommended: pick(args, 'recommended') || '', chosen, why: pick(args, 'why') || '' };
  ensureDir(ROUTE_DIR);
  fs.appendFileSync(path.join(ROUTE_DIR, 'overrides.jsonl'), JSON.stringify(entry) + '\n');
  console.log('override logged');
};

const BANNER = '<!-- AUTO-GENERATED by route_cli.js render. Do not hand-edit. Change the JSON, then render. -->\n\n';
function mdTable(headers, rows) {
  const esc = c => String(c).replace(/\|/g, '\\|');
  const h = `| ${headers.map(esc).join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(r => `| ${r.map(esc).join(' | ')} |`).join('\n');
  return h + '\n' + body + '\n';
}
COMMANDS.render = function () {
  const M = readJSONFile(path.join(ROUTE_DIR, 'matrix.json'));
  const T = readJSONFile(path.join(ROUTE_DIR, 'tool-registry.json'));
  const R = readJSONFile(path.join(ROUTE_DIR, 'recipes.json'));
  const S = loadSkills();
  ensureDir(GEN_DIR);
  if (M) writeText(path.join(GEN_DIR, 'decision-matrix.md'), BANNER + '# Decision matrix\n\n' + mdTable(['id', 'task', 'model', 'effort', 'why'], M.rows.map(r => [r.id, r.task, r.model, r.effort, r.why])));
  if (T) writeText(path.join(GEN_DIR, 'tool-registry.md'), BANNER + '# Tool registry\n\n' + mdTable(['tool', 'use', 'status'], T.tools.map(x => [x.id, x.use, x.status])));
  if (R) writeText(path.join(GEN_DIR, 'recipes-catalog.md'), BANNER + '# Recipes (frameworks)\n\n' + mdTable(['id', 'name', 'model/effort', 'skills', 'tools'], R.recipes.map(x => [x.id, x.name, `${x.model}/${x.effort}`, (x.skills || []).join(' '), (x.tools || []).join(' ')])));
  writeText(path.join(GEN_DIR, 'skills-catalog.md'), BANNER + '# Skill catalog\n\n' + mdTable(['skill', 'scope', 'status', 'keywords'], S.skills.map(x => [x.name, x.scope, x.status, (x.keywords || []).join(' ')])));
  // skills-library.md (P4): the library view grouped by category, then by used_by, with lint state.
  const CATS = ['technical', 'process', 'soft-ref', 'uncategorized'];
  const buckets = { technical: [], process: [], 'soft-ref': [], uncategorized: [] };
  for (const s of S.skills) { const c = buckets[s.category] ? s.category : 'uncategorized'; buckets[c].push(s); }
  let lib = BANNER + '# Skill library\n\nGrouped by category, then by the agents that carry it (used_by). lint = structural quality gate (skills lint).\n';
  for (const c of CATS) {
    const rows = buckets[c].slice().sort((a, b) => a.name.localeCompare(b.name));
    lib += `\n## ${c} (${rows.length})\n\n`;
    lib += rows.length
      ? mdTable(['skill', 'used_by', 'lint', 'status'], rows.map(x => [x.name, (x.used_by || []).join(' ') || '—', x.lint || 'n/a', x.status]))
      : '(none)\n';
  }
  writeText(path.join(GEN_DIR, 'skills-library.md'), lib);
  console.log('rendered generated/ from JSON');
};

function defaultTemplates() {
  return { schema_version: SCHEMA_VERSION, last_modified: nowIso(), templates: [
    { id: 'gemini-wide',  tool: 'gemini',   environment: 'antigravity', mode: 'read-only', focus: 'wide cross-file consistency: does the change break anything elsewhere, is there duplicated logic across files, are there dependency or type conflicts. Use the large context to scan widely.' },
    { id: 'deepseek-deep', tool: 'deepseek', environment: 'roo-code',   mode: 'read-only', focus: 'deep local scan of the listed files: logic errors, edge-case failures, bugs, and each checklist item. Go deep, not wide.' },
    { id: 'rabbit-scan',  tool: 'rabbit',   environment: 'antigravity', mode: 'read-only', focus: 'frontend layout and rendering bugs in the listed files: broken responsive behavior, visual regressions, accessibility issues.' },
  ] };
}
function validateTemplates(t) { if (!t || !Array.isArray(t.templates)) throw new Error('prompt-templates.templates missing'); for (const x of t.templates) { if (!x.id || !x.tool) throw new Error('template needs id+tool'); } }
COMMANDS.template = function (args) {
  const sub = args._[0];
  const T = loadOrDie('prompt-templates.json', validateTemplates);
  if (sub === 'list') { for (const x of T.templates) console.log(`${x.id} [${x.tool}/${x.mode || 'read-only'}] — ${x.focus || ''}`); return; }
  if (sub === 'get') { const id = pick(args, 'id'); const x = T.templates.find(y => y.id === id); if (!x) die(`no template ${id}`); console.log(JSON.stringify(x, null, 2)); return; }
  if (sub === 'add') { const id = slug(pick(args, 'id')); if (!id) die('template add needs --id'); const tool = pick(args, 'tool'); if (typeof tool !== 'string') die('template add needs --tool=<value>'); if (T.templates.find(x => x.id === id)) die(`template ${id} exists`); T.templates.push({ id, tool, environment: pick(args, 'environment') || '', mode: 'read-only', focus: (typeof pick(args, 'focus') === 'string' ? pick(args, 'focus') : '') }); T.last_modified = nowIso(); writeJSONAtomic(path.join(ROUTE_DIR, 'prompt-templates.json'), T); console.log(`added template ${id}`); return; }
  die('template: use list|get|add');
};

const CONTRACT_RULES = [
  'Read only the files listed below. Do not open or scan anything else.',
  'Write only to the single output file named below. Create that one file under your own name.',
  'Do not edit, move, or delete any other file. Nothing in the real project is yours to change.',
  'When done, stop and hand back to Claude Code. Claude Code makes all decisions and all edits to real files.',
  'If a listed file is missing, record it as a blocking note in your report and continue. Do not guess, do not halt.',
];
function buildPrompt(opts) {
  const { template, recipe, task, files, doNotTouch, date, slug: s } = opts;
  const outPath = `/reviews/active/${date}_${s}_${slug(template.tool)}.md`;
  const checklist = (recipe.review_checklist || []);
  const L = [];
  L.push('<role>');
  L.push(`You are a code reviewer operating in READ-ONLY audit mode (${template.tool} via ${template.environment || 'your environment'}).`);
  L.push('You do not modify files. You write one report and hand back to Claude Code.');
  L.push('</role>');
  L.push('');
  L.push('<context>');
  L.push(`Task under review: ${task}`);
  L.push(`Review date: ${date}`);
  L.push('Files in scope (read ONLY these):');
  for (const f of files) L.push(`  - ${f}`);
  if (doNotTouch && doNotTouch.length) { L.push('Do NOT flag or touch (out of scope / known):'); for (const f of doNotTouch) L.push(`  - ${f}`); }
  L.push(`Output file (write ONLY here): ${outPath}`);
  L.push('</context>');
  L.push('');
  L.push('<focus>');
  L.push(template.focus || 'Review the files in scope.');
  L.push('</focus>');
  if (checklist.length) { L.push(''); L.push('<checklist> (return PASS / FAIL / PARTIAL with a one-line note for each)'); for (const c of checklist) L.push(`  - ${c}`); L.push('</checklist>'); }
  L.push('');
  L.push('<constraints>');
  for (const r of CONTRACT_RULES) L.push(`  - ${r}`);
  L.push('</constraints>');
  L.push('');
  L.push('<output_format>');
  L.push(`Write your full report to: ${outPath}`);
  L.push('Sections: ## Summary · ## Issues (file | line | issue | severity) · ## Checklist verdicts');
  L.push('</output_format>');
  return L.join('\n');
}
COMMANDS.prompt = function (args) {
  const recipeId = pick(args, 'recipe'); const toolWanted = pick(args, 'tool');
  const task = pick(args, 'task'); const filesRaw = pick(args, 'files');
  if (typeof task !== 'string' || !task.trim()) die('prompt needs --task="..."');
  if (typeof filesRaw !== 'string') die('prompt needs --files="a,b"');
  const files = listArg(filesRaw) || [];
  const doNotTouch = listArg(pick(args, 'do-not-touch')) || [];
  const R = loadOrDie('recipes.json', validateRecipes);
  const recipe = R.recipes.find(x => x.id === recipeId); if (!recipe) die(`no recipe ${recipeId}`);
  const T = loadOrDie('prompt-templates.json', validateTemplates);
  let template = pick(args, 'template') ? T.templates.find(x => x.id === pick(args, 'template')) : T.templates.find(x => x.tool === toolWanted);
  if (!template) die(`no template for tool ${toolWanted} (try --template=<id>)`);
  ensureDir(path.join(REVIEWS_DIR, 'active'));
  console.log(buildPrompt({ template, recipe, task, files, doNotTouch, date: dateStr(), slug: slug(task) }));
};

function moveReview(fromSub, toSub, file) {
  if (typeof file !== 'string' || path.basename(file) !== file) die('review: --file must be a bare filename');
  const from = path.join(REVIEWS_DIR, fromSub, file);
  if (!fs.existsSync(from)) die(`no review file ${fromSub}/${file}`);
  const toDir = path.join(REVIEWS_DIR, toSub); ensureDir(toDir);
  fs.renameSync(from, path.join(toDir, file));
}
COMMANDS.review = function (args) {
  const sub = args._[0];
  if (sub === 'list') { const dir = path.join(REVIEWS_DIR, 'active'); if (!fs.existsSync(dir)) { console.log('no active reports'); return; } const fs2 = fs.readdirSync(dir).filter(f => f.endsWith('.md')); if (!fs2.length) { console.log('no active reports'); return; } for (const f of fs2) console.log(f); return; }
  if (sub === 'archive') { const f = pick(args, 'file'); if (typeof f !== 'string') die('review archive needs --file=<name>'); moveReview('active', 'archive', f); console.log(`archived ${f}`); return; }
  if (sub === 'to-delete') { const f = pick(args, 'file'); if (typeof f !== 'string') die('review to-delete needs --file=<name>'); moveReview('active', 'to-delete', f); console.log(`flagged ${f} for deletion`); return; }
  if (sub === 'clean') { const dir = path.join(REVIEWS_DIR, 'to-delete'); if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)); console.log('cleaned to-delete'); return; }
  die('review: use list|archive|to-delete|clean');
};

// ============================================================================
// OPERATOR LIFECYCLE (P1): classify · models · runs store · stats · profile
// Zero model tokens: every decision below is a rule + code, judgment stays with
// the model at the nodes the SKILL.md marks. See plan section 4.5 (determinism map).
// ============================================================================

function fail2(msg) { process.stderr.write(msg + '\n'); process.exit(2); }
function todayStr() {
  if (process.env.ROUTE_TODAY) return process.env.ROUTE_TODAY;
  try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }); }
  catch (e) { return dateStr(); }
}

// ---------- classify (tier heuristic, no model call) ----------
function classifyTask(text, profile) {
  text = String(text || '');
  const low = text.toLowerCase();
  const words = low.match(/[a-z0-9]+/g) || [];
  const wset = new Set(words);
  const has = w => wset.has(w);
  let score = 0; const reasons = [];
  const STRONG = ['build', 'create', 'design', 'migrate', 'overhaul', 'framework', 'system', 'architect', 'redesign', 'refactor', 'rewrite', 'rebuild'];
  const WEAK = ['fix', 'edit', 'update', 'add', 'tweak', 'adjust'];
  for (const w of STRONG) if (has(w)) { score += 2; reasons.push('+2 ' + w); }
  for (const w of WEAK) if (has(w)) { score += 1; reasons.push('+1 ' + w); }
  if (/\b(test|tests|spec|specs)\b/.test(low)) { score += 1; reasons.push('+1 tests'); }
  if (/\b(schema|registry|database|pipeline|api|endpoint|integration)\b/.test(low)) { score += 1; reasons.push('+1 structural component'); }
  const broad = (/\b(all|every)\s+\w+/.test(low) && /\b(employees?|projects?|agents?|files?|components?|schemas?|users?|tasks?|services?|modules?|systems?|endpoints?)\b/.test(low))
    || /\ball projects\b/.test(low) || /\bevery agent\b/.test(low) || /\bacross (all )?projects\b/.test(low) || /\bmulti-?(week|session|project)\b/.test(low);
  if (broad) { score += 2; reasons.push('+2 broad/multi scope'); }
  if (text.length > 240) { score += 1; reasons.push('+1 long description'); }
  if (/^\s*(what|where|who|show|status|list|which|when|is|are|do|does|can)\b/.test(low)) { score -= 2; reasons.push('-2 question/status form'); }
  // per-project tuning by rule, not by model
  const co = (profile && profile.classify_overrides) || {};
  for (const k of (co.promote || [])) if (low.includes(String(k).toLowerCase())) { score += 2; reasons.push('+2 profile-promote:' + k); }
  for (const k of (co.demote || [])) if (low.includes(String(k).toLowerCase())) { score -= 2; reasons.push('-2 profile-demote:' + k); }
  let tier;
  if (score <= 0) tier = 'T0';
  else if (score <= 2) tier = 'T1';
  else if (score <= 4) tier = 'T2';
  else tier = 'T3';
  const novelSystem = /\b(system|framework|program|platform|engine)\b/.test(low) && /\b(my|new|from scratch|scratch)\b/.test(low);
  if (novelSystem && tier !== 'T3') { tier = 'T3'; reasons.push('novel system/framework pairing -> T3'); }
  const out = { tier, score, reasons };
  if (score === 4 && tier === 'T2') out.borderline = 'recommend adding the critique stage or promoting to T3';
  return out;
}
COMMANDS.classify = function (args) {
  let task;
  if (pick(args, 'stdin')) { try { task = fs.readFileSync(0, 'utf8'); } catch (e) { task = ''; } }
  else task = args._.join(' ').trim() || pick(args, 'task') || '';
  task = String(task || '').trim();
  if (!task) die('classify needs a task (positional arg or --stdin)');
  const profile = store.readJSON(path.join(OPERATOR_DIR, 'profile.json'));
  const res = classifyTask(task, profile);
  if (pick(args, 'json')) { console.log(JSON.stringify(res)); return; }
  console.log(`tier=${res.tier} score=${res.score}`);
  if (res.reasons.length) console.log('reasons: ' + res.reasons.join('; '));
  if (res.borderline) console.log('borderline: ' + res.borderline);
};

// ---------- models ladder resolution (availability + liveness aware) ----------
function loadModels() { return store.readJSON(path.join(ROUTE_DIR, 'models.json')); }
function modelAvailable(def, today) {
  if (!def || !def.availability) return true;
  const { from, to } = def.availability;
  if (from && today < from) return false;
  if (to && today > to) return false;
  return true;
}
function resolveLadder(role) {
  const M = loadModels();
  if (!M || !M.ladder || !M.ladder[role]) return { model: null, fallbacks: [], effort_defaults: (M && M.effort_defaults) || {} };
  const today = todayStr();
  const avail = M.ladder[role].filter(id => modelAvailable(M.models && M.models[id], today));
  return { model: avail[0] || null, fallbacks: avail.slice(1), effort_defaults: M.effort_defaults || {} };
}
COMMANDS.models = function (args) {
  const sub = args._[0];
  if (sub === 'resolve') {
    const role = pick(args, 'role'); if (!role) die('models resolve needs --role=<digest|reason|execute|review>');
    const { model, fallbacks } = resolveLadder(role);
    if (!model) die(`no model resolved for role "${role}" (check models.json ladder)`);
    if (pick(args, 'json')) { console.log(JSON.stringify({ role, model, fallbacks })); return; }
    console.log(`${role} -> ${model}` + (fallbacks.length ? ` (fallbacks: ${fallbacks.join(', ')})` : ' (fallbacks: none)'));
    return;
  }
  if (sub === 'list') {
    const M = loadModels(); if (!M) die('models.json missing');
    for (const [id, d] of Object.entries(M.models || {})) console.log(`${id} [${(d.roles || []).join(',')}]` + (d.availability ? ` avail ${d.availability.from}..${d.availability.to}` : ''));
    return;
  }
  die('models: use resolve|list');
};

// ---------- runs store (route_cli owns lifecycle state; chain_cli untouched) ----------
const STAGES_T3 = ['digest', 'clarify', 'plan', 'approve', 'build', 'verify', 'critique', 'fix', 'close'];
const STAGES_T2 = ['clarify', 'plan', 'build', 'verify', 'close'];
const STAGE_ROLE = { digest: 'digest', plan: 'reason', build: 'execute', verify: 'execute', critique: 'review', fix: 'execute' };
function newStage(name) { const s = { status: 'pending' }; if (name === 'verify') s.attempts = 0; if (name === 'critique') s.critical_findings = null; return s; }
function runFile(id) { return path.join(RUNS_DIR, id + '.json'); }
function loadRun(id) { return store.readJSON(runFile(id)); }
function saveRun(r) { r.updated_at = nowIso(); store.atomicWrite(runFile(r.id), r); }
function genRunId() { return `run_${todayStr()}_${crypto.randomBytes(4).toString('hex')}`; }
function artifactExists(a) {
  if (!a) return false;
  for (const b of [null, OPERATOR_DIR, RESOLVED_ROOT, process.cwd()]) {
    const p = b ? path.resolve(b, a) : path.resolve(a);
    if (fs.existsSync(p)) return true;
  }
  return false;
}
function fillTemplate(tpl, vars) { return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null) ? String(vars[k]) : m); }
function runHandoff(args) {
  const id = args._[1]; if (!id) die('run handoff needs <id>');
  const rec = loadRun(id); if (!rec) fail2(`no run ${id}`);
  const stage = pick(args, 'stage'); if (!stage) die('run handoff needs --stage=<build|verify|critique>');
  const tplFile = path.join(TEMPLATES_DIR, `handoff-${stage}.md`);
  if (!fs.existsSync(tplFile)) die(`no handoff template for stage "${stage}" (${tplFile})`);
  const tpl = fs.readFileSync(tplFile, 'utf8');
  const { model, fallbacks, effort_defaults } = resolveLadder(STAGE_ROLE[stage] || 'execute');
  // L0022: cross-project handoff. When the BUILD runs in a DIFFERENT project than the one that
  // produced the plan, pass --target-root=<abs>; the prompt then names that root and rewrites the
  // plan/brief paths as ABSOLUTE against the ORIGIN root so the target session can still find them.
  const targetRoot = pick(args, 'target-root', 'target_root');
  const explicitPlan = pick(args, 'plan-path', 'plan_path');
  let planPath = explicitPlan || (rec.stages.plan && rec.stages.plan.artifact) || `plans/${todayStr()}-${slug(rec.task)}-plan.md`;
  let briefPath = (rec.stages.digest && rec.stages.digest.artifact) || `runs/${id}/brief.md`;
  if (targetRoot) {
    if (!path.isAbsolute(planPath)) planPath = path.resolve(rec.project_root, planPath);
    if (!path.isAbsolute(briefPath)) briefPath = path.resolve(rec.project_root, briefPath);
  }
  const vars = {
    run_id: id,
    project_root: targetRoot ? path.resolve(targetRoot) : rec.project_root,
    model: model || 'opus-4-8',
    effort: (effort_defaults && effort_defaults[stage]) || 'normal',
    fallbacks: fallbacks.length ? fallbacks.join(' -> ') : 'none',
    plan_path: planPath,
    brief_path: briefPath,
  };
  const out = fillTemplate(tpl, vars);
  store.atomicWrite(path.join(RUNS_DIR, id, `handoff-${stage}.md`), out);
  console.log(out);
}
COMMANDS.run = function (args) {
  const sub = args._[0];
  if (sub === 'start') {
    const task = args._.slice(1).join(' ').trim() || pick(args, 'task') || '';
    if (!task) die('run start needs a task');
    const tier = String(pick(args, 'tier') || 'T3').toUpperCase();
    if (tier !== 'T2' && tier !== 'T3') die('run start: --tier must be T2 or T3 (T0/T1 pass through with no run)');
    const names = tier === 'T2' ? STAGES_T2 : STAGES_T3;
    const stages = {}; for (const n of names) stages[n] = newStage(n);
    const id = genRunId();
    const now = nowIso();
    const rec = {
      schema_version: SCHEMA_VERSION, id, task, task_id: pick(args, 'task-id') || null,
      project_root: RESOLVED_ROOT, tier, stage: names[0], rework_count: 0, stages,
      created_at: now, updated_at: now,
    };
    store.atomicWrite(runFile(id), rec);
    console.log(`started ${id} (tier ${tier}, ${names.length} stages, stage=${names[0]})`);
    return;
  }
  if (sub === 'stage') {
    const id = args._[1]; if (!id) die('run stage needs <id>');
    const rec = loadRun(id); if (!rec) fail2(`no run ${id}`);
    const name = pick(args, 'name'); if (!name) die('run stage needs --name=<stage>');
    if (!(name in rec.stages)) fail2(`unknown stage "${name}" for this ${rec.tier} run`);
    const status = pick(args, 'status');
    const artifact = pick(args, 'artifact');
    if (name === 'verify') {
      if (status === 'done' || status === 'failed') rec.stages.verify.attempts = (rec.stages.verify.attempts || 0) + 1;
      if (status === 'done' && !artifactExists(artifact)) fail2('verify done requires --artifact pointing at an existing report file');
    }
    if (typeof status === 'string') rec.stages[name].status = status;
    if (typeof artifact === 'string') rec.stages[name].artifact = artifact;
    const note = pick(args, 'note'); if (typeof note === 'string') (rec.stages[name].notes = rec.stages[name].notes || []).push(note);
    const mf = pick(args, 'model-fallback'); if (typeof mf === 'string') rec.stages[name].model_fallback = mf;
    if (name === 'critique') { const cf = pick(args, 'critical'); if (cf !== undefined) rec.stages.critique.critical_findings = Number(cf); }
    if (pick(args, 'rework')) rec.rework_count = (rec.rework_count || 0) + 1;
    rec.stage = name;
    saveRun(rec);
    console.log(`${id}: ${name} -> ${status || rec.stages[name].status}`);
    return;
  }
  if (sub === 'get') {
    const id = args._[1]; const rec = loadRun(id); if (!rec) fail2(`no run ${id}`);
    if (pick(args, 'json')) { console.log(JSON.stringify(rec, null, 2)); return; }
    console.log(`${rec.id} [${rec.tier}] stage=${rec.stage} rework=${rec.rework_count}`);
    for (const [n, s] of Object.entries(rec.stages)) console.log(`  ${n}: ${s.status}${s.artifact ? ' (' + s.artifact + ')' : ''}`);
    return;
  }
  if (sub === 'list') {
    if (!fs.existsSync(RUNS_DIR)) { console.log('no runs'); return; }
    const recs = fs.readdirSync(RUNS_DIR).filter(f => f.endsWith('.json')).map(f => store.readJSON(path.join(RUNS_DIR, f))).filter(Boolean);
    if (pick(args, 'json')) { console.log(JSON.stringify(recs.map(r => ({ id: r.id, tier: r.tier, stage: r.stage, rework: r.rework_count })), null, 2)); return; }
    for (const r of recs) console.log(`${r.id} [${r.tier}] stage=${r.stage}`);
    return;
  }
  if (sub === 'handoff') return runHandoff(args);
  die('run: use start|stage|get|list|handoff');
};

// ---------- stats (self-reported first-pass rate, artifact-backed) ----------
function criticalCount(rec) {
  const crit = rec.stages && rec.stages.critique;
  if (crit && crit.artifact) {
    for (const b of [OPERATOR_DIR, RESOLVED_ROOT, process.cwd()]) {
      const p = path.resolve(b, crit.artifact);
      if (fs.existsSync(p)) { return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(l => /^\s*(-\s*)?CRITICAL/.test(l)).length; }
    }
  }
  if (crit && typeof crit.critical_findings === 'number') return crit.critical_findings;
  return 0;
}
COMMANDS.stats = function (args) {
  const trailing = Number(pick(args, 'trailing')) || 20;
  const asJson = pick(args, 'json');
  if (!fs.existsSync(RUNS_DIR)) { if (asJson) console.log(JSON.stringify({ n: 0, first_pass: 0, rework_rate: 0, per_stage: {} })); else console.log('no runs yet'); return; }
  const all = fs.readdirSync(RUNS_DIR).filter(f => f.endsWith('.json')).map(f => store.readJSON(path.join(RUNS_DIR, f))).filter(Boolean);
  const closed = all.filter(r => r.stages && r.stages.close && r.stages.close.status === 'done')
    .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
  const t2plus = closed.filter(r => r.tier === 'T2' || r.tier === 'T3').slice(-trailing);
  const n = t2plus.length;
  const firstPass = t2plus.filter(r => {
    const v = r.stages.verify;
    const passedFirst = v && v.status === 'done' && (v.attempts || 1) === 1;
    return passedFirst && criticalCount(r) === 0;
  }).length;
  const reworked = t2plus.filter(r => (r.rework_count || 0) > 0).length;
  const per_stage = {};
  for (const r of t2plus) for (const [name, s] of Object.entries(r.stages)) if (s.status === 'done') per_stage[name] = (per_stage[name] || 0) + 1;
  const first_pass = n ? Number((firstPass / n).toFixed(3)) : 0;
  const rework_rate = n ? Number((reworked / n).toFixed(3)) : 0;
  const openStale = all.filter(r => !(r.stages && r.stages.close && r.stages.close.status === 'done')).length;
  const result = { n, first_pass, rework_rate, per_stage, target: 0.95, measurable: n >= 20, open_runs: openStale };
  if (asJson) { console.log(JSON.stringify(result)); return; }
  console.log(`route stats — self-reported first-pass rate (trailing ${trailing}, artifact-backed)`);
  console.log(`closed T2+ runs: ${n}` + (openStale ? `   open runs: ${openStale}` : ''));
  console.log(`first_pass: ${first_pass}   rework_rate: ${rework_rate}`);
  console.log('per-stage done: ' + (Object.keys(per_stage).length ? Object.entries(per_stage).map(([k, v]) => `${k}=${v}`).join(' ') : '(none)'));
  if (n >= 20) console.log(`target: first_pass >= 0.95 trailing 20; current: ${first_pass}`);
  else console.log(`n=${n}, target not yet measurable (need 20 closed T2+ runs)`);
};

// ---------- profile (per-project operator overlay) ----------
function defaultProfile(projectId) {
  return {
    schema_version: SCHEMA_VERSION,
    project_id: projectId,
    domain: '',
    north_star: '',
    money_lane: '',
    model_prefs: {},
    effort_bias: 'normal',
    classify_overrides: { promote: [], demote: [] },
    doctrine_overlays: [],
    interview_pack: [
      'Which lane does this serve (money now vs compounding)?',
      'What must NOT change?',
      'What does done look like, in one sentence?'
    ],
    guardrail_refs: ['safety/PERMISSIONS.md', 'safety/guardrails.md'],
    recipes_local: [],
    notes: ''
  };
}
COMMANDS.profile = function (args) {
  const sub = args._[0];
  const pPath = path.join(OPERATOR_DIR, 'profile.json');
  if (sub === 'init') {
    const projectId = slug(path.basename(RESOLVED_ROOT)) || 'project';
    const existing = store.readJSON(pPath) || {};
    const def = defaultProfile(projectId);
    let changed = false;
    for (const k of Object.keys(def)) if (!(k in existing)) { existing[k] = def[k]; changed = true; }
    store.atomicWrite(pPath, existing);
    console.log(changed ? `profile initialized at ${pPath}` : `profile already complete at ${pPath} (no change)`);
    return;
  }
  if (sub === 'get') {
    const p = store.readJSON(pPath); if (!p) die('no profile — run: route_cli profile init');
    const key = pick(args, 'key');
    if (key) { console.log(JSON.stringify(p[key] !== undefined ? p[key] : null)); return; }
    console.log(JSON.stringify(p, null, 2));
    return;
  }
  if (sub === 'set') {
    const key = pick(args, 'key'); if (!key) die('profile set needs --key=<name>');
    const raw = pick(args, 'value');
    const p = store.readJSON(pPath) || defaultProfile(slug(path.basename(RESOLVED_ROOT)) || 'project');
    let v = raw; try { v = JSON.parse(raw); } catch (e) { /* keep as string */ }
    p[key] = v;
    store.atomicWrite(pPath, p);
    console.log(`profile.${key} set`);
    return;
  }
  die('profile: use init|get|set');
};

function help() {
  console.log('route_cli — LAXAI pre-flight advisor data layer');
  console.log('commands: ' + Object.keys(COMMANDS).sort().join(' | '));
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') { help(); process.exit(0); }
  const cmd = argv[0];
  if (!COMMANDS[cmd]) die(`unknown command: ${cmd}`);
  COMMANDS[cmd](parseArgs(argv.slice(1)));
}

main();

module.exports = { parseArgs, pick, slug, listArg, extractKeywords };
