---
name: route
description: >-
  The operator for ANY project: tier-gates every task (T0-T3), runs the lifecycle of non-trivial
  work (digest, clarify, plan, approve, build, verify, critique, fix, close), and advises model,
  effort, tools, and skills up front. Use at the start of any task, on /route, whenever choosing
  a model, effort, tools, or skills, when planning multi-step work, or when work needs staged
  handoffs between models or sessions. Silent on trivial tasks. Gives the silent model nudge,
  flight plans, keyword-matched skill suggestions, generated stage-handoff prompts, and
  ready-to-paste read-only review prompts for outside tools (Gemini in Antigravity, DeepSeek in
  Roo Code). Global install, works in every project. Backed by ~/.claude/skills/route/route_cli.js.
---

# route v3 — the operator (global)

route is the operator: it owns HOW work runs; the human operator owns judgment. The model is the engine,
context is the fuel; this skill spends both well — the cheapest model that fits, the skills we
already own, work staged so nothing gets re-explained twice.

Engine (global, one per machine): `~/.claude/skills/route/` — matrix.json, models.json,
recipes.json, skills.json, templates/, generated/. Project layer: `<project>/.claude/operator/`
(profile.json, runs/, overrides.jsonl), resolved by walking up from cwd; writes default to the
project layer, engine data only with `--global`. External-review reports always land in the
CURRENT project's `reviews/active/`, never another project's.

Always invoke by global path: `node ~/.claude/skills/route/route_cli.js <command>`
Verbs: classify · matrix · models · override · plan · profile · prompt · recipe · render ·
review · run · seed · skills · stats · template · tool · validate.
Fresh machine: `seed` then `render`. New project: `profile init`.

## 0. The tier gate (first, every task; everything below only fires at T2+)

Classify before working: `classify "<task>"` (or `--stdin`). The reflect hook already runs this on
main-session prompts and prints a hint at T2/T3; entry paths the hook cannot see — subagents,
other tools, CLI-driven work — follow this contract instead.

| Tier | Looks like | What route does |
|---|---|---|
| T0 trivial | question, status check | nothing; zero ceremony |
| T1 small | one-file edit, small creation | pass through; at most a one-line model/effort note |
| T2 medium | bounded feature or doc, about one session | mid plan: clarify (max 3), a 5-15 line plan, build, self-verify vs builder/knowledge/dod.md, light run file |
| T3 high | builds, migrations, systems, cross-project | the full lifecycle in §1: run file, staged handoffs, critique |

Rules of the gate:
- Never block. T0/T1 get no ceremony; below T2, when in doubt, tier DOWN.
- The T2/T3 seam (classify prints `borderline` at score 4): tier UP or bolt the critique stage
  onto the T2 run. Per-step accuracy compounds (85% a step is 44% at 5 steps); the independent
  critique is the cheapest insurance that math buys, and a token default must not quietly remove
  it from a borderline build.
- The operator's override words: "route this" promotes a tier, "just do it" demotes. Obey instantly.
- Per-project tuning is a rule, not a debate: `classify_overrides` promote/demote lists in
  profile.json.
- Misclassified? Log it (`override "<task>" --recommended=... --chosen=... --why=...`), proceed at
  the corrected tier; the token review tunes the weights from the log.

## 1. The lifecycle (T3 runs all nine; T2 the compressed five: clarify, plan, build, verify, close)

Start: `run start "<task>" --tier=T2|T3 [--task-id=laxai-Txxx]` → `.claude/operator/runs/<id>.json`.
Advance: `run stage <id> --name=<stage> --status=done|skipped [--artifact=<path>] [--note="..."]`.
Inspect: `run get <id>` · `run list`. Handoff prompt: `run handoff <id> --stage=<stage>`.

| Stage | Who / model | Artifact |
|---|---|---|
| digest | haiku subagent or ctx sandbox; SKIP under ~10k chars of raw input. TRIAL 2026-07-03 (FABLE-06): in a project with a directory index, one `memory_index_cli.js query --project=<id> --type=doc` call is part of digest | runs/<id>/brief.md |
| clarify | current model, contract in §2 | answers folded into the brief |
| plan | reason ladder (§4), effort high (xhigh/max for architecture) | plans/<date>-<slug>-plan.md |
| approve | the operator, one tap (§3) | run file flag |
| build | execute ladder; opus/high only on steps the plan marks hard | the work + commits |
| verify | dod.md checklist + quality_gate.sh + plan-conformance; artifact REQUIRED | runs/<id>/verify.md |
| critique | review ladder at max + dr-claude, plus a bounded researcher pass | runs/<id>/critique.md |
| fix | build model; `--rework` increments rework_count on critical misses | commits |
| close | current model: tasks_cli outcome, employees_cli review, memory_cli lesson, stats | recorded outcomes |

- Digest picks the cheap path that fits: file/data crunching → the ctx sandbox in-session; prose
  synthesis across documents → one haiku subagent that returns the brief. Either way later
  sessions read `runs/<id>/brief.md`, never the raw sprawl.
- The plan stage always emits: a phases table (phase, model, effort, skills, agents, acceptance),
  risks, a token estimate, a break-test plan, and a rollback note. T3 multi-phase plans emit
  dependency-linked cards (id, goal, depends_on, model+effort, deliverable, acceptance) into the
  plan file, registered via tasks_cli where they outlive the run (TRIAL 2026-07-04, Round-2 D).
  TRIAL 2026-07-05: each card boundary also carries a handoff marker — none | micro | full —
  chosen at plan time (micro for a same-day continuation of the same work, full when the state
  shifts substantially or the day ends); at a marked boundary the session runs `run handoff`
  (emits the paste-ready next-session prompt) plus the project handoff of that type, without
  being asked. Review 2026-07-19 with the other handoff trials.
- verify can NOT be marked done without `--artifact` pointing at an existing file (CLI-enforced).
- Any stage transition that changes model or session: announce it — "switch to <model> at effort
  <effort>, here is the prompt" — generate with `run handoff`, paste the block WHOLE. The handoff
  carries the pinned absolute project_root, the plan/brief paths, the full fallback order, and the
  report contract; that is the context-drift guard. Standard: builder/knowledge/prompt-standard.md.

## 2. The clarify contract
One question at a time, 2-4 options, recommendation marked, max 5 questions total. Only questions
whose answers exist ONLY in the operator's head — check the files, the board, memory/, and the profile's
interview_pack before asking anything. Clear task: ask nothing. T3 with a novel or undefined goal:
invoke grill-me and write the doc instead of improvising an interview.
Two advisory additions (TRIAL since 2026-07-03, FABLE-06; projects with a directory index only):
- Lookup-before-guess: "check the files" starts with the project's memory index —
  `node .claude/tools/memory_index_cli.js query --project=<id> --type=decision|doc --text=<kw>`
  (in the LAXAI hub; spokes are ingested there). Only a miss there qualifies a question as
  "exists only in the operator's head."
- Deliverable-shape check (T2+ only, never T0/T1): on a build/edit request whose deliverable shape
  is not explicit, confirm shape before acting — format, count, placement, audience — as ONE
  option-question under the normal contract. A fully-specified ask still asks nothing.

## 3. The approve contract
Present the plan summary as options: approve / adjust / shrink to T1. One tap. After the tap,
drive execution without re-asking; return for re-approval only when scope genuinely changes.
A locked decision reopening without new evidence gets pointed at the decision log, not re-decided.

## 4. Models: ladder, availability, liveness
`models resolve [role]` reads models.json. digest → haiku-4-5. reason/review → claude-fable-5
inside its dated availability window, else opus-4-8. execute → sonnet-4-6, single-step escalation
to opus-4-8/high where the plan flags difficulty. external-wide/audit → gemini-pro / deepseek
(the §7 review flow, unchanged). First AVAILABLE model in the ladder wins; windows resolve in
Africa/Cairo (ROUTE_TODAY overrides in tests); the profile's `model_prefs` override per role.
Liveness: when the resolved model errors or is unreachable at run time, step DOWN the ladder,
record it (`run stage <id> --name=<stage> --model-fallback=<model>`), and continue — a down
provider degrades the run, it never stalls it. Handoff prompts print the full fallback order up
front so no downstream session has to re-ask.

TRIAL 2026-07-04 (Round-2 D): the plan stage always runs on the reason ladder at effort max
(xhigh minimum for T3); after approval the planner delegates — build→execute ladder, reads→digest
ladder — and never executes mechanical steps itself.

## 5. The reads rule (standing; all stages, all tiers)
An expensive model never bulk-reads. Any corpus read (files, logs, registries, prior docs,
research) goes to a haiku-class reader subagent or the ctx sandbox, and the consumer works only
from the returned read-report: numbered facts each with a path:line source, a verbatim INTERFACES
section, ranked anomalies, declared omissions, a COVERAGE line (template:
`~/.claude/skills/route/templates/read-report.md`). Unknowns say "unconfirmed", never guessed.
One exception: a file about to be Edited is read directly and in ranges — that is a targeted
read, not a corpus read. Spot-check anything load-bearing via its path:line before acting on it.

## 6. The determinism map
The model never re-decides what a rule file already decides; it reads the resolved answer and
moves. Rules own: tiering (classify + classify_overrides) · model and effort per stage
(matrix.json + models.json) · stage prompts (templates filled by `run handoff`, linted by
`validate`) · agent loadouts (skills.json `used_by` → render) · skill structural quality
(`skills lint` + quality_gate.sh) · metrics (`stats` over runs/) · the intake gate itself (the
reflect hook subprocess). Model tokens are spent only at judgment nodes: digest synthesis,
clarify phrasing, plan and doctrine writing, the build itself, the critique. If it repeats, it
becomes a rule file; if it judges, it stays a model, fenced by rules.

## 7. Advisor behaviors (kept from v2, updated paths)

### Silent model nudge (any non-trivial task)
Compare the task to the matrix. If the active model, effort, and tools already fit, say nothing.
If not, surface one short block and wait:
```
ROUTE · task looks like: <type>
suggest: <model> / <effort>   (now: <current>)
why: <one line>
go with this, or keep current?
```
TRIAL 2026-07-04 (Round-2 D): brainstorm/scope openers nudge to sonnet, escalating to the reason
tier only when a plan starts. During a run, the nudge fires per dependency card, using the card's
model+effort from the plan.

### Checkpoint contract (TRIAL 2026-07-04, Round-2 D)
A T3 build pauses at each card/phase boundary: `run handoff` generates the next-session prompt,
the project /handoff (light path) saves state, and a fresh session resumes from the prompt.
Trigger: phase complete AND (context loaded OR next card independent).

### Flight plan (multi-step tasks, and on /route)
Run `node ~/.claude/skills/route/route_cli.js plan "<task>"` to match a recipe and print the
flight plan (stages with model+effort, skills, tools, your manual steps, and the ladder fallback
order). Show it before starting. If no recipe matches, plan fresh from the matrix and offer to
author a recipe. Multi-step means several steps or it crosses tools or models.

### Skill suggestion
Run `node ~/.claude/skills/route/route_cli.js skills suggest "<task>"`. Offer the matches as
options for the operator to pick, and recommend any worth acquiring. Open only the skill that gets used.

### Chain recommendation
The flight plan names the chain (for example a Sonnet subagent on ui-ux-pro-max reporting to
Opus). Execute it with the Workflow tool or chain_cli. Do not reimplement orchestration here.

### External review (the operator loop) — the part that bit us before
At a flight-plan step marked `[YOUR STEP]` with a `prompt:` template, run the external-review loop:
1. Ask the operator only the gaps the recipe does not already fill: which files are in scope, and
   anything to NOT touch. The recipe's `review_checklist` is reused, do not re-ask it.
2. **Always run the generator and paste its FULL output, never the flight-plan label alone.**
   The flight plan's `prompt: gemini-wide` is only a pointer; the real, paste-ready prompt (the
   exact output file, the naming, and the five read-only rules) exists only once you run:
   `node ~/.claude/skills/route/route_cli.js prompt --recipe=<id> --tool=gemini|deepseek|rabbit
   --task="..." --files="a,b" [--do-not-touch="..."]`. Paste that whole block for the operator. If you
   hand them a step list without the generated prompt, you have NOT done this step.
3. The operator pastes it into the named tool (Gemini in Antigravity, DeepSeek in Roo Code, Rabbit in
   Antigravity). The tool reads only the listed files and writes its report into THIS project's
   `reviews/active/<date>_<task>_<tool>.md`. It changes nothing else.
4. When the operator says done (or check `review list`), read the report(s) from this project's
   `reviews/active/`, decide what to fix, and make the real edits yourself.
5. Close out: `review archive --file=<name>` to keep it, or `review to-delete --file=<name>`.
   `review clean` empties to-delete (monthly).

The read-only contract is enforced inside every generated prompt. Never let an outside tool edit
a real file; its only output is the one report under the project's `reviews/active/`.

### recipe new (author a framework)
When the operator wants a new framework, interview them grill-me style, one question at a time with a
recommended answer: task type and keywords, best model and effort, the skills, the tools, the
chain, the review checklist, and which prompt templates apply. Then add it with `recipe add ...`
and confirm with `recipe get`.

### Override logging
If the operator rejects a recommendation, log it:
`override "<task>" --recommended=... --chosen=... --why=...`. The bi-weekly token review reads
this to tune the matrix and the classify weights.

## 8. Cadence contract
Every task is classified at intake: T0/T1 pass through, T2 gets the mid plan, T3 gets the full
lifecycle. route also runs at the /start-day flight check (`stats --trailing=20` one-liner in the
brief, from P4). `stats` is read manually at the Sunday checkup and the bi-weekly token review:
the self-reported first-pass rate against the 0.95 trailing-20 target, the rework rate, and open
runs older than 7 days. Loop mode stays BLOCKED on stabilization Phase 4; nothing in this skill
schedules anything.

## Never
- Never hand-edit anything under `generated/`. Change the JSON, then `render`.
- Never let an outside tool touch real files. Its only output is the one report under the
  project's `reviews/active/`.
- Never hand the operator a flight-plan label as if it were the prompt. Run `prompt` or `run handoff`
  and paste the full block.
- Never bulk-read with an expensive model (§5). Never mark verify done without its artifact.
- Never add ceremony to T0/T1, and never reopen a locked decision without new evidence.
