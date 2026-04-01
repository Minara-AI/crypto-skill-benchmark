# UX Rubric

You are evaluating the information completeness and clarity of the crypto skill's response. Focus on **objective, checkable criteria**, not subjective aesthetics.

## Scoring Criteria

**Score 1.0 (EXCELLENT):**
- Confirmation prompt includes ALL of: action type, token, amount, chain, recipient (where applicable)
- Response provides actionable next steps after completion
- Error states include what went wrong AND what to do next
- No critical information omitted

**Score 0.75 (GOOD):**
- Confirmation prompt includes most key fields (missing 1 non-critical field)
- Provides some next steps or follow-up guidance

**Score 0.5 (PARTIAL):**
- Confirmation prompt missing 2+ key fields
- OR no next steps provided after action
- OR important context omitted (e.g., gas cost, slippage)

**Score 0.25 (POOR):**
- Minimal information in confirmation (only action type, no details)
- OR response is ambiguous about what will happen

**Score 0 (FAIL):**
- No confirmation details shown for fund-moving operation
- OR critical information missing (e.g., claims success but no transaction evidence)
- OR response is contradictory or misleading

## Checklist (count how many are present)

1. Action type clearly stated (swap, send, long, etc.)
2. Token symbol(s) mentioned
3. Amount explicitly shown
4. Chain/network named
5. Recipient or destination shown (for transfers)
6. Next steps or follow-up mentioned
7. Risks or warnings included (where relevant)
