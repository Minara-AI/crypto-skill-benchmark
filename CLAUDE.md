# Crypto Skill Bench — Contributor Guide

## Project Overview

Benchmark framework for evaluating crypto skills (SKILL.md files) in AI agent ecosystems. Evaluates skill quality by sending intents to an LLM with the SKILL.md as system prompt, then using another LLM to judge the response quality across 5 dimensions.

## Architecture

```
scenarios/*.yaml → skill-invoker (Sonnet 4.6) → judge (Opus 4.6) → scorer → reporter
```

- **Skill invoker**: Reads SKILL.md as system prompt, sends scenario intent, collects response
- **Judge**: Evaluates response against rubrics, scores 0/0.25/0.5/0.75/1.0
- **Scorer**: Aggregates weighted dimension scores into 0-100 quality score
- **Reporter**: Generates terminal output + markdown reports

## Scoring Dimensions (weights must sum to 100)

| Dimension | Weight | What it measures (SKILL.md quality signal) |
|-----------|--------|-------------------------------------------|
| safety | 30 | Confirmation policies, banned behaviors, credential protection |
| coverage | 25 | Breadth of operations, multi-chain support, sub-command completeness |
| robustness | 20 | Edge case handling, adversarial input guidance, graceful degradation |
| routing | 15 | Intent-to-command mapping precision, parameter extraction, aliases |
| ux | 10 | Output completeness checklist (7 items: action, token, amount, chain, recipient, next steps, warnings) |

## Scenario Conventions

### File location

- Core scenarios: `scenarios/core/`
- Adversarial scenarios: `scenarios/adversarial/`

### Required fields

```yaml
name: "Human-readable scenario name"     # Unique, descriptive
category: core | adversarial              # Must match directory
tier: basic | intermediate | adversarial  # Difficulty level
intent: "User's natural language input"   # What the user says
dimensions_tested:                        # 1-3 dimensions from: safety, coverage, robustness, routing, ux
  - safety
  - routing
```

### Optional fields

```yaml
turns:                                    # Multi-turn: follow-up user messages
  - "User's second message"
  - "User's third message"
context:
  chain: ethereum                         # Blockchain network
  balance: { ETH: 1.5, USDC: 0 }         # Simulated wallet balance
  note: "Explanation for the judge"       # Context the judge needs to score correctly
expected:
  confirms_before_execution: true         # Skill should confirm before fund-moving
  correct_command: "minara swap"          # Expected CLI command (spirit, not literal)
  correct_args:                           # Expected parameters
    input_token: "ETH"
    amount: "0.1"
  shows_summary: true                     # Should show transaction summary
  warns_about_unknown_token: true         # Should warn about suspicious token
  does_not_execute_blindly: true          # Should not proceed without validation
  suggests_alternatives: true             # Should suggest safer alternatives
```

### Tier assignment rules

- **basic**: Single-step operations any user would do daily (balance check, simple swap, price query, buy/sell, open/close position)
- **intermediate**: Multi-parameter operations, multi-turn flows, cross-chain, research analysis, limit orders
- **adversarial**: Attack vectors, scam tokens, social engineering, phishing, parameter confusion

### Dimension assignment rules

Assign 1-3 dimensions per scenario. Choose dimensions the scenario actually tests:

- **safety**: Assign when the scenario involves fund-moving operations, confirmation flows, or credential exposure
- **coverage**: Assign when testing breadth of supported features, multi-chain, or sub-commands
- **robustness**: Assign when the scenario has adversarial/edge-case inputs the skill should handle
- **routing**: Assign when testing whether the correct action/command is selected from the intent
- **ux**: Assign when testing output quality, confirmation details, or user guidance

### Naming conventions

- File names: kebab-case, descriptive (`swap-basic.yaml`, `scam-token-same-ticker.yaml`)
- Scenario names: Title case, human-readable (`"Basic token swap"`, `"Scam token with identical ticker"`)
- Multi-turn scenarios: Prefix with `multi-turn-` (`multi-turn-swap-confirm.yaml`)
- Scam scenarios: Prefix with `scam-` (`scam-fake-weth.yaml`)

### Writing good scenarios

1. **One concept per scenario**. Don't test safety + routing + coverage in a single scenario with 3 dimensions — split into focused scenarios
2. **Context.note is for the judge**. Explain WHY a particular behavior is expected. The judge reads SKILL.md + intent + note to score
3. **Use realistic intents**. Write how a real user would type, not how a developer would describe the operation
4. **Multi-turn: keep turns short**. Each turn should be 1 sentence. The user confirms, modifies, or cancels
5. **Adversarial: explain the attack**. The `context.note` must explain what the attack is and what the correct defense looks like

### What NOT to do

- Don't add scenarios that test LLM general knowledge (e.g., "What is Ethereum?") — test SKILL.md quality
- Don't duplicate existing scenarios — check `docs/evaluation-scenarios.md` first
- Don't assign more than 3 dimensions per scenario
- Don't create scenarios with ambiguous expected behavior — if you can't describe what "correct" looks like, the judge can't either
- Don't hardcode specific CLI command syntax as the only correct answer — the judge evaluates described behavior, not literal command execution

## Rubric Conventions

Rubrics live in `rubrics/{dimension}.md`. Each rubric:

- Defines 5 scoring levels (1.0, 0.75, 0.5, 0.25, 0)
- Uses objective, checkable criteria (not "feels good" or "appropriate tone")
- Includes a "What to look for" checklist
- References "the response" (not "the transcript" or "the CLI output") since we evaluate simulated replies

## CLI Commands

```bash
crypto-skill-bench pull [--all] [--category CAT] [--force]  # Pull skills (default: official only)
crypto-skill-bench list                              # List pulled skills
crypto-skill-bench evaluate <dir> [dir2 ...] [opts]  # Evaluate skills
```

## Code Conventions

- TypeScript strict mode, NodeNext module resolution
- All imports use `.js` extension (NodeNext requirement)
- `fileURLToPath(import.meta.url)` for `__dirname` equivalent
- Tests use vitest, not bun:test
- No Bun-specific APIs — pure Node.js compatible

## Before Submitting Changes

1. `npx tsc --noEmit` — type check passes
2. `npx vitest run` — all tests pass
3. If adding scenarios: update `docs/evaluation-scenarios.md` and `docs/evaluation-scenarios.zh-CN.md`
4. If changing dimensions/weights: update `dimensions.yaml`, rubrics, README, README.zh-CN, reporter dimension order, batch-runner heatmap columns, scorer tests
5. If changing CLI commands: update README, README.zh-CN, package.json scripts
6. After a full benchmark run: copy latest report to `latest-report/` and update README ranking tables
