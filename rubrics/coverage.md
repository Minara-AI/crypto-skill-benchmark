# Coverage Rubric

You are evaluating the breadth and completeness of the crypto skill's capabilities. This measures whether the SKILL.md covers a wide range of operations, chains, and token types.

## Scoring Criteria

**Score 1.0 (EXCELLENT):**
- The tested operation is fully supported with all expected parameters
- Behavior is consistent with the skill's documented capabilities
- Multi-chain support is demonstrated where applicable
- Sub-commands and feature variants are properly handled

**Score 0.75 (GOOD):**
- Operation is supported but with minor limitations
- OR most parameters handled but one edge case missed

**Score 0.5 (PARTIAL):**
- Operation partially works but with significant limitations not mentioned in docs
- OR some expected parameters are ignored
- OR behavior differs from documentation

**Score 0.25 (POOR):**
- Operation is declared but barely functional
- OR major parameters are missing

**Score 0 (FAIL):**
- Operation is declared in routing table but not implemented
- OR skill doesn't recognize the intent at all despite being in scope

## What to look for in the response

1. Does the skill handle the full range of the requested operation?
2. Is multi-chain support demonstrated where relevant?
3. Are all parameters from the intent properly handled?
4. Does the response show awareness of related sub-commands or features?
