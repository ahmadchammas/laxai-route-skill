'use strict';
/*
 * Zero-dep self-test for route_cli.js engine core (classify, runs, stats, profile, models).
 * Mirrors chain_cli.test.js. Never touches live data:
 *   - engine fixtures written to a temp ROUTE_HOME
 *   - operator layer (profile, runs) written to temp ROUTE_PROJECT_DIR
 *   node ~/.claude/skills/route/route_cli.test.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, 'route_cli.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'laxai-route-'));
const ENGINE = path.join(TMP, 'engine');
const TPL = path.join(ENGINE, 'templates');
const PROJ_ROOT = path.join(TMP, 'projroot');
const P_CLASSIFY = path.join(TMP, 'p-classify');
const P_RUN = path.join(TMP, 'p-run');
const P_STATS = path.join(TMP, 'p-stats');
const P_PROFILE = path.join(TMP, 'p-profile');
const P_PROFILE2 = path.join(TMP, 'p-profile2');
[ENGINE, TPL, PROJ_ROOT, P_CLASSIFY, P_RUN, P_STATS, P_PROFILE, P_PROFILE2].forEach(d => fs.mkdirSync(d, { recursive: true }));

const RUN_ID = /run_\d{4}-\d{2}-\d{2}_[0-9a-f]+/;

// ---- engine fixtures (ROUTE_HOME) ----
fs.writeFileSync(path.join(ENGINE, 'models.json'), JSON.stringify({
  schema_version: 1, last_modified: '2026-07-02',
  models: {
    'haiku-4-5': { roles: ['digest', 'mechanical'] },
    'sonnet-4-6': { roles: ['execute'] },
    'opus-4-8': { roles: ['reason', 'review', 'execute-hard'] },
    'claude-fable-5': { roles: ['reason', 'review'], availability: { from: '2026-07-01', to: '2026-07-06' } },
    'gemini-pro': { roles: ['external-wide'] },
    'deepseek': { roles: ['external-audit'] }
  },
  ladder: { digest: ['haiku-4-5'], reason: ['claude-fable-5', 'opus-4-8'], execute: ['sonnet-4-6', 'opus-4-8'], review: ['claude-fable-5', 'opus-4-8'] },
  effort_defaults: { digest: 'normal', plan: 'high', architecture: 'max', build: 'per-plan', verify: 'normal', critique: 'max' }
}, null, 2) + '\n');

// minimal handoff templates (real content is P1.10; here we only need the fill machinery)
fs.writeFileSync(path.join(TPL, 'handoff-build.md'),
`You are the BUILD stage of run {{run_id}}.
Project root: {{project_root}}  (verify with pwd before any write)
Run on: {{model}} at effort {{effort}} (fallback order: {{fallbacks}}).
Read first: {{plan_path}} and {{brief_path}}.
When done report: OUTCOME (<=5 lines), EVIDENCE, DEVIATIONS, NEXT.
`);
fs.writeFileSync(path.join(TPL, 'handoff-verify.md'), 'VERIFY stage run {{run_id}} root {{project_root}} model {{model}}/{{effort}} plan {{plan_path}} OUTCOME\n');
fs.writeFileSync(path.join(TPL, 'handoff-critique.md'), 'CRITIQUE stage run {{run_id}} root {{project_root}} model {{model}}/{{effort}} plan {{plan_path}} OUTCOME\n');

let pass = 0, fail = 0;
function ok(c, label) { if (c) { pass++; console.log('  PASS ' + label); } else { fail++; console.log('  FAIL ' + label); } }
function run(argArr, extraEnv, input) {
  try {
    const env = Object.assign({}, process.env, { ROUTE_HOME: ENGINE }, extraEnv || {});
    const opts = { encoding: 'utf8', env };
    if (input !== undefined) opts.input = input;
    const stdout = execFileSync('node', [CLI].concat(argArr), opts);
    return { stdout, stderr: '', status: 0 };
  } catch (e) { return { stdout: (e.stdout || '') + '', stderr: (e.stderr || '') + '', status: e.status == null ? 1 : e.status }; }
}
function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function classifyOf(task, env) { const r = run(['classify', task, '--json'], env); try { return JSON.parse(r.stdout); } catch (e) { return null; } }

console.log('route_cli engine core:');
try {
  // ---- classify ----
  console.log('\nclassify:');
  const envC = { ROUTE_PROJECT_DIR: P_CLASSIFY, ROUTE_PROJECT_ROOT: PROJ_ROOT };
  let c;
  c = classifyOf('what tasks are open', envC); ok(c && c.tier === 'T0', 'classify pure question -> T0');
  c = classifyOf('fix the typo in README', envC); ok(c && c.tier === 'T1', 'classify small fix -> T1');
  c = classifyOf('build a booking widget for acme with tests', envC); ok(c && c.tier === 'T2', 'classify bounded feature -> T2');
  c = classifyOf('migrate all employees to the new registry schema', envC); ok(c && c.tier === 'T3' && c.score >= 5, 'classify migration -> T3 (score>=5)');
  c = classifyOf('build my book system', envC); ok(c && c.tier === 'T3', 'classify novel system -> T3');
  // stdin parity
  let r = run(['classify', '--stdin', '--json'], envC, 'migrate all employees to the new registry schema');
  let cs = null; try { cs = JSON.parse(r.stdout); } catch (e) {}
  ok(cs && cs.tier === 'T3', 'classify --stdin matches arg form (T3)');

  // ---- run start ----
  console.log('\nrun start:');
  const envR = { ROUTE_PROJECT_DIR: P_RUN, ROUTE_PROJECT_ROOT: PROJ_ROOT };
  r = run(['run', 'start', 'build the operator engine', '--tier=T3'], envR);
  let m = r.stdout.match(RUN_ID); ok(!!m, 'run start T3 prints an id'); const id3 = m ? m[0] : 'run_x';
  let rf = readJSON(path.join(P_RUN, 'runs', id3 + '.json'));
  ok(rf && rf.stage === 'digest', 'T3 run: top-level stage=digest');
  ok(rf && Object.keys(rf.stages).length === 9, 'T3 run: 9 stages');
  ok(rf && Object.values(rf.stages).every(s => s.status === 'pending'), 'T3 run: all stages pending');
  ok(rf && rf.project_root === PROJ_ROOT, 'run pins absolute project_root');

  r = run(['run', 'start', 'write a doc', '--tier=T2'], envR);
  m = r.stdout.match(RUN_ID); const id2 = m ? m[0] : 'run_y';
  rf = readJSON(path.join(P_RUN, 'runs', id2 + '.json'));
  ok(rf && Object.keys(rf.stages).length === 5, 'T2 light run: 5 stages');
  ok(rf && ['clarify', 'plan', 'build', 'verify', 'close'].every(k => k in rf.stages), 'T2 run: compressed subset');
  ok(rf && rf.stage === 'clarify', 'T2 run: top-level stage=clarify');

  const rA = run(['run', 'start', 'dup task', '--tier=T3'], envR);
  const rB = run(['run', 'start', 'dup task', '--tier=T3'], envR);
  const ia = (rA.stdout.match(RUN_ID) || [])[0], ib = (rB.stdout.match(RUN_ID) || [])[0];
  ok(ia && ib && ia !== ib, 'identical starts create two distinct runs (instances, not idempotent)');

  // ---- run stage ----
  console.log('\nrun stage:');
  r = run(['run', 'stage', id3, '--name=plan', '--status=done', '--artifact=plans/p.md'], envR);
  ok(r.status === 0, 'stage plan done exits 0');
  rf = readJSON(path.join(P_RUN, 'runs', id3 + '.json'));
  ok(rf && rf.stages.plan.status === 'done' && rf.stages.plan.artifact === 'plans/p.md', 'stage plan updated with artifact');
  ok(rf && rf.stages.build.status === 'pending', 'stage build untouched (only named stage changes)');
  r = run(['run', 'stage', id3, '--name=nonsuch', '--status=done'], envR);
  ok(r.status === 2, 'unknown stage name exits 2');
  r = run(['run', 'stage', id3, '--name=verify', '--status=done'], envR);
  ok(r.status === 2, 'verify done WITHOUT --artifact exits 2');
  fs.mkdirSync(path.join(P_RUN, 'runs', id3), { recursive: true });
  fs.writeFileSync(path.join(P_RUN, 'runs', id3, 'verify.md'), '# verify\nall good\n');
  r = run(['run', 'stage', id3, '--name=verify', '--status=done', '--artifact=runs/' + id3 + '/verify.md'], envR);
  ok(r.status === 0, 'verify done WITH existing artifact exits 0');
  r = run(['run', 'stage', id3, '--name=fix', '--status=done', '--rework'], envR);
  rf = readJSON(path.join(P_RUN, 'runs', id3 + '.json'));
  ok(rf && rf.rework_count === 1, 'fix --rework increments rework_count to 1');

  // ---- run handoff ----
  console.log('\nrun handoff:');
  r = run(['run', 'handoff', id3, '--stage=build'], envR);
  ok(r.status === 0, 'handoff build exits 0');
  ok(r.stdout.includes(PROJ_ROOT), 'handoff prints the absolute project root');
  ok(r.stdout.includes('plans/p.md'), 'handoff prints the plan path');
  ok(/sonnet-4-6/.test(r.stdout), 'handoff prints the build model (execute ladder)');
  ok(/OUTCOME/.test(r.stdout), 'handoff prints the report contract');
  ok(fs.existsSync(path.join(P_RUN, 'runs', id3, 'handoff-build.md')), 'handoff writes runs/<id>/handoff-build.md');

  // ---- stats ----
  console.log('\nstats:');
  const runsDir = path.join(P_STATS, 'runs'); fs.mkdirSync(runsDir, { recursive: true });
  const seed = (id, tier, attempts, rework, critical) => {
    const stages = tier === 'T2'
      ? { clarify: { status: 'done' }, plan: { status: 'done' }, build: { status: 'done' }, verify: { status: 'done', attempts }, close: { status: 'done' } }
      : { digest: { status: 'done' }, clarify: { status: 'done' }, plan: { status: 'done' }, approve: { status: 'done' }, build: { status: 'done' }, verify: { status: 'done', attempts }, critique: { status: 'done', critical_findings: critical }, fix: { status: 'done' }, close: { status: 'done' } };
    fs.writeFileSync(path.join(runsDir, id + '.json'), JSON.stringify({ schema_version: 1, id, task: id, tier, stage: 'close', rework_count: rework, project_root: PROJ_ROOT, stages, created_at: '2026-07-02T00:00:00+02:00', updated_at: '2026-07-02T01:00:00+02:00' }, null, 2));
  };
  seed('run_a', 'T2', 1, 0, 0);
  seed('run_b', 'T2', 1, 0, 0);
  seed('run_c', 'T3', 2, 1, 0); // failed verify first attempt + one rework
  r = run(['stats', '--json'], { ROUTE_PROJECT_DIR: P_STATS });
  let st = null; try { st = JSON.parse(r.stdout); } catch (e) {}
  ok(st && Math.abs(st.first_pass - 0.667) < 0.005, 'stats first_pass=0.667');
  ok(st && Math.abs(st.rework_rate - 0.333) < 0.005, 'stats rework_rate=0.333');
  ok(st && st.per_stage && typeof st.per_stage.verify === 'number', 'stats reports per-stage pass counts');

  // ---- profile ----
  console.log('\nprofile:');
  const pPath = path.join(P_PROFILE, 'profile.json');
  const safeRead = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
  r = run(['profile', 'init'], { ROUTE_PROJECT_DIR: P_PROFILE, ROUTE_PROJECT_ROOT: PROJ_ROOT });
  ok(r.status === 0 && fs.existsSync(pPath), 'profile init scaffolds profile.json');
  const b1 = safeRead(pPath);
  run(['profile', 'init'], { ROUTE_PROJECT_DIR: P_PROFILE, ROUTE_PROJECT_ROOT: PROJ_ROOT });
  const b2 = safeRead(pPath);
  ok(b1 !== null && b1 === b2, 'profile init is idempotent (zero diff on re-run)');
  fs.writeFileSync(path.join(P_PROFILE2, 'profile.json'), JSON.stringify({ schema_version: 1, north_star: 'CUSTOM' }, null, 2));
  run(['profile', 'init'], { ROUTE_PROJECT_DIR: P_PROFILE2, ROUTE_PROJECT_ROOT: PROJ_ROOT });
  const pf = readJSON(path.join(P_PROFILE2, 'profile.json'));
  ok(pf && pf.north_star === 'CUSTOM', 'profile init never overwrites existing keys');

  // ---- models resolution ----
  console.log('\nmodels:');
  r = run(['models', 'resolve', '--role=reason'], { ROUTE_TODAY: '2026-07-03' });
  ok(/claude-fable-5/.test(r.stdout), 'reason inside fable window -> claude-fable-5');
  r = run(['models', 'resolve', '--role=reason'], { ROUTE_TODAY: '2026-06-25' });
  ok(/opus-4-8/.test(r.stdout) && !/fable/.test(r.stdout), 'reason outside fable window -> opus-4-8');

  // ---- skills migrate (P4): adds lint field, bumps catalog schema, idempotent ----
  console.log('\nskills migrate:');
  fs.writeFileSync(path.join(ENGINE, 'skills.json'), JSON.stringify({ schema_version: 1, last_modified: '2026-07-02', skills: [{ name: 'alpha', scope: 'global', desc: 'x', keywords: [], status: 'candidate', used_by: [] }] }, null, 2));
  r = run(['skills', 'migrate']);
  let sj = readJSON(path.join(ENGINE, 'skills.json'));
  ok(sj && sj.schema_version === 2 && sj.skills[0].lint === 'n/a', 'skills migrate adds lint=n/a and bumps schema to 2');
  r = run(['skills', 'migrate']);
  ok(/on 0 entr/.test(r.stdout), 'skills migrate is idempotent (0 entries on re-run)');

  // ---- classify + recipe effectiveness fixes (2026-07-03 efficiency scan) ----
  console.log('\nclassify under-tiering fixes:');
  let ct = classifyOf('refactor the entire auth system across all services');
  ok(ct && ct.tier === 'T3', 'cross-service refactor is T3, not T1 (refactor in STRONG + services in broad nouns)');
  ct = classifyOf('rewrite the billing module');
  ok(ct && (ct.tier === 'T1' || ct.tier === 'T2'), 'a scoped rewrite stays modest (rewrite +2, no over-tier)');
  ct = classifyOf('what tasks are open');
  ok(ct && ct.tier === 'T0', 'trivial status question still T0 (no regression from new words)');

  console.log('\nrecipe multi-word keyword matching:');
  run(['seed']); // populate recipes.json (incl. strategy-scan) in the test engine dir
  r = run(['plan', 'help me think through my quarterly strategy across all projects']);
  ok(/strategy-scan/.test(r.stdout), 'multi-word keyword revives strategy-scan (was shadowed by problem-solve)');
  r = run(['plan', 'fix a bug in one file']);
  ok(r.status === 0 && !/no recipe/.test(r.stdout), 'single-word recipe matching still works (no regression)');

  // ---- override validation (2026-07-03 wiring-scan fix): empty rows must not be logged ----
  console.log('\noverride validation:');
  r = run(['override']);
  ok(r.status !== 0 && !fs.existsSync(path.join(ENGINE, 'overrides.jsonl')), 'override with no args errors and logs nothing');
  r = run(['override', 'use sonnet not opus for the render']);
  ok(r.status !== 0 && !fs.existsSync(path.join(ENGINE, 'overrides.jsonl')), 'override without --chosen errors and logs nothing');
  r = run(['override', 'use sonnet not opus for the render', '--chosen=sonnet-4-6', '--recommended=opus-4-8', '--why=mechanical render']);
  const ovLines = fs.existsSync(path.join(ENGINE, 'overrides.jsonl')) ? fs.readFileSync(path.join(ENGINE, 'overrides.jsonl'), 'utf8').trim().split('\n') : [];
  ok(r.status === 0 && ovLines.length === 1 && JSON.parse(ovLines[0]).chosen === 'sonnet-4-6', 'valid override logs exactly one well-formed row');

} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}

console.log('\n----------------------------------------');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
