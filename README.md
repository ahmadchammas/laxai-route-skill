# laxai-route-skill

A Claude Code skill that acts as the "operator" for any project: it tier-gates every task
(T0 trivial → T3 high), picks the cheapest model/effort that fits the work, matches tasks to
recipes (frameworks with a model/skill/tool chain), and runs a staged lifecycle (clarify → plan →
approve → build → verify → critique → fix → close) for anything non-trivial.

Zero npm dependencies — pure Node stdlib.

## Install

Drop this folder at `~/.claude/skills/route/` (global, one per machine). Claude Code picks it up
automatically as a skill named `route`.

```
git clone <this-repo-url> ~/.claude/skills/route
```

## First run

```
node ~/.claude/skills/route/route_cli.js seed
```

This seeds `matrix.json`, `tool-registry.json`, `recipes.json`, and `prompt-templates.json` if
they're missing (the ones in this repo are already seeded with sane defaults — `seed` won't
overwrite them). `skills.json` (your own skill catalog) is intentionally not shipped; the tool
builds it fresh as you use `route_cli.js skills add/scan` in your own projects.

Then, per project you want it active in:

```
node ~/.claude/skills/route/route_cli.js profile init
```

## What it does

- `classify "<task>"` — tiers a task T0-T3, the gate everything else hangs off
- `plan "<task>"` — matches a recipe and prints a flight plan (stages, model, effort, skills, tools)
- `models resolve [role]` — resolves the model ladder for a role, honoring dated availability windows
- `run start/stage/get/list/handoff` — drives the staged lifecycle for T2/T3 work, one JSON file per run
- `skills suggest "<task>"` — keyword-matches your own installed skills to a task
- `override` / `stats` — logs corrections and reports first-pass/rework rates over time

Full command reference and the operating rules are in `SKILL.md`.

## What's NOT in this repo

This is a sanitized fork of a personal setup. Left out on purpose:

- `skills.json`, `.backups/`, `generated/`, `overrides.jsonl`, `reviews/` — all personal data
  (one person's actual skill catalog, decision history, and file paths). The tool works fine
  without them and rebuilds its own copies as you use it.
- A few docs reference companion tools from the author's own setup (`tasks_cli.js`,
  `employees_cli.js`, `memory_cli.js`, a `dr-claude` review agent, a `grill-me` interview skill).
  Those are optional enrichments mentioned in the lifecycle stages — the core classify/plan/models/
  recipes machinery works standalone without them.

## Tests

```
node route_cli.test.js
```

## License

MIT — see `LICENSE`.
