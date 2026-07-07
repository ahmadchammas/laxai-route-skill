# Close: run {{run_id}}
A run is not closed until every item is true. Close honestly: no "done" without these.
- [ ] tasks_cli: the task's outcome recorded (node .claude/tools/tasks_cli.js update <task_id> --status=done|canceled --outcome="..." --confirmed-by=<operator>).
- [ ] employees_cli review: for each agent that ran a stage, log its track-record (node .claude/tools/employees_cli.js review ...).
- [ ] memory_cli lesson: if the run taught a durable rule, record it (node .claude/tools/memory_cli.js ...); else state "no lesson".
- [ ] stats refreshed: run `node ~/.claude/skills/route/route_cli.js run stage {{run_id}} --name=close --status=done`, then `route_cli stats` prints this run.
- [ ] board honest: dashboard + INDEX reflect reality; no stale card, no closed-task-as-blocker, rework count told straight.
Report: OUTCOME (<=5 lines), EVIDENCE (what you recorded where), NEXT.
