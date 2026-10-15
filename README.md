# pylon-tui

A Claude Code mod for a calmer terminal UI:

- A docked **Session** pane: directory, branch, cost and usage limits, model, context bar, plan, changed files with diffs, and background agents. Toggle it with `/dock`.
- Folded rows for reads, searches and edits.
- A turn summary line: time, duration, files changed and the total diff.
- Spinner labels that say what Claude is doing.

## Install

At the prompt of a terminal session:

```
/plugin install pylon-tui --marketplace FadhilP/cc-pylon-tui
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install pylon-tui --marketplace FadhilP/cc-pylon-tui
```
