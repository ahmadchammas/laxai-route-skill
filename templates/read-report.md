# Read report: {{scope}}   (reader: {{reader_model}}, consumer: {{consumer_model}})
VERDICT (1 line): what this corpus is and does.
FACTS (numbered; EVERY fact carries its path:line source): the load-bearing facts, decisions,
  constraints, and numbers. Numbers copied exactly, never rounded.
INTERFACES (exact, verbatim): schemas, JSON shapes, command surfaces, signatures, field names
  the consumer will touch. This section is copy-paste faithful, not paraphrased.
RISKS / ANOMALIES (ranked): contradictions between files, stale content, TODOs, drift, gaps.
QUOTES (verbatim, max 5, each with path:line): only where exact wording matters
  (a guardrail, a locked decision, an error message).
OMITTED (1-2 lines): what was skipped and why that is safe.
COVERAGE (1 line): "this report faithfully represents ~X% of the corpus; uncovered: <parts>",
  so the consumer knows when to commission a second reader instead of trusting silence.
Rules: no raw dumps; unknowns say "unconfirmed", never guessed. Length: as short as faithful;
  a faithful INTERFACES section may run long, and it is never truncated to hit a cap.
