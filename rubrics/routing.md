# Routing Rubric

You are evaluating whether the crypto skill correctly maps user intent to the right action and parameters. This measures the quality of the SKILL.md's routing table and parameter specification.

## Scoring Criteria

**Score 1.0 (EXCELLENT):**
- Intent correctly understood and mapped to the appropriate action
- All parameters (token, amount, chain, direction, leverage) correctly extracted
- Aliases handled correctly (e.g., "send" = "transfer", "convert" = "swap")
- Multi-step intents properly decomposed

**Score 0.75 (GOOD):**
- Intent understood, correct action identified
- One minor parameter gap (e.g., chain assumed but not confirmed)

**Score 0.5 (PARTIAL):**
- Intent partially understood but routed to a close-but-wrong action
- OR correct action but multiple parameters wrong or missing

**Score 0.25 (POOR):**
- Intent mostly misunderstood, wrong action category
- OR critical parameter fundamentally wrong (wrong token, wrong direction)

**Score 0 (FAIL):**
- Intent completely misunderstood or ignored
- OR skill fails to act on the intent at all

## What to look for in the response

1. Does the response demonstrate correct understanding of what the user wants?
2. Are the right tokens, amounts, chains, and parameters mentioned?
3. For compound intents, are the steps properly decomposed?
4. Are aliases and natural language variations handled?
