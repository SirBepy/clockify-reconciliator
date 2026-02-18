## Summary

A developer's project is under legal investigation requiring detailed justification of ~5 months of billed hours. The original Clockify time-tracking entries are vague, shorthand, or cover multiple merged tasks—making them indefensible for legal and client review. This tool automatically enriches these entries using GitHub commit history and Jira ticket data as source-of-truth, producing professional, detailed, and defensible time records without changing total hours logged. The enriched output must satisfy both client stakeholders and potentially legal teams, with 80%+ coverage, low-confidence entries flagged for manual review, and strict preservation of total logged hours (no inflation or deflation). While this is a one-time urgent need, the tool could become a company-wide solution for similar situations.

## Context & Problem

**Who's Affected:**

- **Primary**: A developer facing legal investigation who needs to justify 5 months of logged work hours to client stakeholders and potentially legal teams
- **Secondary**: The company, which could face legal consequences (lawsuit, breach of contract) if time records are deemed indefensible
- **Future**: Other developers in the company who may face similar audits or investigations

**Current Pain:**

The developer diligently tracked time in Clockify over 5 months but entries are often vague or incomplete due to:

- **Time pressure**: Logging quickly during work to avoid interrupting development flow
- **Multi-tasking reality**: Working on multiple tasks simultaneously, making it difficult to track when one task ended and another began, leading to merged entries
- **Lack of detail**: Sometimes not knowing what else to say about a task's progression beyond shorthand notes

Example problematic entries:

- "Big batch of tasks (361, 480, 427, 441) + Create build" — 4.5 hours (which task took how long?)
- "Fixing bugs" — 5.3 hours (what bugs? what was the complexity?)
- "Daily Standup" — 34.5 hours total across many entries (clearly includes more than just standups)

**The Stakes:**

This isn't about better record-keeping—it's about legal defensibility. If these time records can't be justified:

- **Legal consequences**: Potential lawsuit or breach of contract claims
- **Financial loss**: Hours may be disputed or not paid
- **Professional reputation**: Trust damage with client and employer

**What's Missing:**

The developer has the source-of-truth data (GitHub commits, PRs, Jira tickets) that proves the work was done, but manually enriching hundreds of entries would take days. The entries need to be:

- **Professional**: Written in clear, business-appropriate language
- **Detailed**: Specific about what was accomplished, not vague shorthand
- **Defensible**: Backed by actual code changes and ticket history
- **Accurate**: Total hours must remain unchanged (no inflation or deflation)

**The Need:**

An automated tool that uses GitHub and Jira data to reconstruct what actually happened on each day, split merged entries into their component tasks with estimated time distributions, and produce a CSV that can be submitted to legal/client review with confidence.

**Success Criteria (Product-level):**

- 80%+ of entries are enriched with medium/high confidence.
- Low-confidence entries are clearly flagged for targeted manual review.
- Total hours are preserved per day and in aggregate (no net change).
- Output is understandable to non-technical reviewers and defensible in legal/client scrutiny.
- The developer can review the output in hours, not days.
- The tool can produce two outputs: (1) a “mirrored” CSV that matches the input schema closely for compatibility, and (2) a standardized CSV for review/analysis with additional AI metadata columns.

&nbsp;
