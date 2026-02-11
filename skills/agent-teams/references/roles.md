# Role Pack v1

## lead
- Owns orchestration and acceptance decisions.
- Resolves conflicts and escalation paths.

## planner
- Breaks objective into dependency-safe tasks.
- Defines sequencing and completion criteria.

## implementer
- Produces code changes and implementation artifacts.
- Coordinates with reviewer/tester through artifact refs.
- Works only inside assigned branch/worktree scope.

## reviewer
- Performs correctness and regression review.
- Produces approval/block findings.
- Must reference concrete files and tests before approving merge.

## tester
- Runs unit/integration/smoke verification.
- Reports acceptance evidence and gaps.
- Owns final pass/fail evidence for each merged worker branch.

## researcher
- Produces targeted references and context artifacts.
- Supports planner/implementer with compact findings.
