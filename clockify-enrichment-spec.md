# Clockify Enrichment Tool — Project Spec

## Overview

A Node.js CLI tool that automatically enriches and rewrites Clockify time-tracking entries using GitHub commit/PR history and Jira ticket data as context. The goal is to produce professional, detailed, and defensible time-tracking records that accurately reflect the work done — without ever changing the total hours logged.

This tool was designed for a legal context where a company needs to demonstrate that logged hours are accurate and well-documented. The output should be a rewritten Clockify CSV that mirrors the input format exactly, ready for submission.

---

## Background & Motivation

The developer tracked ~5 months of work in Clockify. Entries were logged in good faith but sometimes:
- A single entry covers multiple tasks (e.g. "6 hours" with 3-4 tasks listed)
- Descriptions are vague or shorthand
- Time was spent on debugging, calls, reviews, or back-and-forth that isn't obvious from the entry alone

The tool should use GitHub and Jira as source-of-truth to enrich these entries with real context, split multi-task entries with estimated time distributions, and add justification for entries that took unusually long.

---

## Core Principles

1. **Never change total hours.** If a Clockify entry says 6 hours, the output must still total 6 hours. Time can be redistributed across split tasks but never inflated or deflated.
2. **The developer's descriptions are trustworthy.** They were diligent about logging calls, debugging sessions, build processes, etc. The AI should treat existing descriptions as accurate and build on them, not contradict them.
3. **Reasonable guessing is acceptable.** When splitting multi-task entries, the AI can estimate time distribution based on commit complexity, file changes, and Jira ticket complexity. These are informed estimates, not fabrications.
4. **Day-by-day matching is the primary strategy.** The core question is: "What did this developer actually push/close on this day, and does it match what they claimed to work on?"
5. **Output must be reviewable.** The developer reviews all AI-generated descriptions before submission. The tool produces a draft, not a final product.

---

## Pipeline Architecture

The tool runs in three sequential stages. Each stage produces a structured JSON file that feeds into the next stage. This keeps context manageable and costs low.

```
Stage 1a: GitHub Summarizer
Stage 1b: Jira Summarizer
         ↓
Stage 2: Clockify Enricher (final AI pass)
         ↓
Output: enriched-clockify.csv
```

---

## Stage 1a — GitHub Summarizer

### Input
- GitHub personal access token (read-only, scoped to the relevant repo)
- Repository owner + name
- Developer's GitHub username/email (to filter only their commits)
- Date range (start and end of employment period)

### What to fetch
- All PRs authored by the developer in the date range
- All commits within each PR
- For commits not in any PR (direct pushes), group them by day

### What to summarize per PR
```json
{
  "pr_number": 42,
  "pr_title": "Feature: User authentication flow",
  "pr_description": "first 300 chars only",
  "merged_at": "2024-03-15",
  "commits_count": 7,
  "files_changed": 12,
  "lines_added": 340,
  "lines_removed": 89,
  "had_review_comments": true,
  "review_iterations": 2,
  "modules_touched": ["auth", "user", "api/middleware"],
  "commit_messages": ["add login endpoint", "fix token expiry bug", "address PR review comments"],
  "complexity_signal": "high"
}
```

### Complexity signal logic
- **low**: <3 commits, <5 files, no review iterations
- **medium**: 3-6 commits OR 5-15 files OR 1 review iteration
- **high**: 7+ commits OR 15+ files OR 2+ review iterations OR commit messages suggest debugging/rework

### Important notes
- A single PR may contain work for multiple Jira tasks — this is expected and fine
- Commit messages are more valuable than line counts for understanding what was done
- "fix review comments" or "address feedback" type commits are strong signals that extra time was spent on rework
- Modules touched (derived from file paths) help the final AI understand what area of the codebase was affected

### Output file
`github-summary.json` — array of PR summaries, plus a `commits_by_day` map for any commits outside PRs

---

## Stage 1b — Jira Summarizer

### Input
- Jira base URL
- Jira personal access token or API token
- Jira project key(s)
- Developer's Jira account ID or display name
- Date range

### What to fetch
Fetch all Jira tickets that were either:
- Assigned to the developer at any point
- Transitioned by the developer
- Within the date range

### What to summarize per ticket

#### Always include
```json
{
  "ticket_id": "PROJ-123",
  "title": "Implement password reset flow",
  "type": "Story",
  "story_points": 5,
  "final_status": "Done",
  "description_summary": "AI-compressed to max 150 words",
  "acceptance_criteria": "included if present, max 100 words",
  "back_to_development_count": 2,
  "status_history": [
    { "status": "In Progress", "date": "2024-03-10" },
    { "status": "In Review", "date": "2024-03-12" },
    { "status": "Back to Development", "date": "2024-03-13", "triggered_by": "QA" },
    { "status": "Done", "date": "2024-03-15" }
  ]
}
```

#### Include comments only when
- `back_to_development_count >= 1` — fetch comments around each "Back to Development" transition (±24 hours)
- Total logged hours for this ticket across Clockify exceed 10 hours
- When fetching comments, summarize them — do not include raw comment text. Max 100 words per comment batch.

#### Why status history matters
A ticket that went "Back to Development" twice is essentially 3 separate tasks. This explains why hours were higher than expected and should be reflected in the enriched descriptions. This is the Jira equivalent of GitHub's review iterations.

#### Description handling
The full description should always be summarized (never skipped) because:
- Sometimes tickets were written one way but requirements changed during calls
- The description may be vague, but combined with status history and comments, the full picture emerges
- Compress to ~150 words max — enough context, not enough noise

### Output file
`jira-summary.json` — array of ticket summaries

---

## Stage 2 — Clockify Enricher

This is the main AI pass. It receives all three inputs and produces the enriched CSV.

### Input
- `clockify-export.csv` — original, unmodified
- `github-summary.json` — from Stage 1a
- `jira-summary.json` — from Stage 1b

### Core matching strategy: Day-by-Day

For each Clockify entry:
1. Get the date of the entry
2. Find all GitHub PRs merged or commits pushed on that date by the developer
3. Find all Jira tickets transitioned on that date by the developer
4. Match them against the Clockify description using fuzzy/semantic matching
5. If a match is found, enrich the description with real context
6. If no match is found on that exact date, look ±1 day (work sometimes gets pushed the day after)

### Multi-task entry handling

When a single Clockify entry contains multiple tasks (e.g. "worked on login, fixed navbar bug, call with client"):
- Split the entry into sub-entries
- Distribute hours based on:
  - Commit complexity signals from GitHub
  - Ticket story points from Jira
  - Nature of the task (calls are usually 30-60 min, debugging is variable)
- Total of sub-entries must equal original entry total
- Mark each sub-entry clearly as an AI-estimated split

### Long task justification

When a single task or group of entries totals more than 8 hours:
- Check if the corresponding PR had multiple review iterations
- Check if the Jira ticket went "Back to Development"
- Check if commit messages show debugging/rework patterns
- Use these signals to write a justification note in the description

### Output format

The output CSV must mirror the input Clockify CSV format exactly, with these changes:
- `Description` field rewritten with enriched content
- If an entry was split, each sub-entry becomes its own row (same date, same project, hours distributed)
- New column added: `AI_Confidence` — values: `high`, `medium`, `low` (so developer knows what to review closely)
- New column added: `AI_Notes` — brief internal note explaining what data was used to enrich this entry (e.g. "matched to PR #42, Jira PROJ-123, 2x back-to-dev")

### Description writing style

- Professional, first-person, past tense ("Implemented user authentication flow...")
- Specific where possible ("...including JWT token generation, middleware validation, and refresh token logic")
- Honest about process work ("Addressed review feedback on PR #42, refactored token expiry handling per reviewer comments")
- Honest about investigation time ("Investigated intermittent login failures, traced root cause to race condition in session middleware")
- Never fabricate specific technical details that aren't supported by commit/Jira data

---

## Configuration

All secrets and settings live in a single `config.json` file (gitignored):

```json
{
  "clockify": {
    "input_csv": "./input/clockify-export.csv",
    "output_csv": "./output/enriched-clockify.csv"
  },
  "github": {
    "personal_access_token": "",
    "repo_owner": "",
    "repo_name": "",
    "developer_username": "",
    "date_from": "2024-01-01",
    "date_to": "2024-06-01"
  },
  "jira": {
    "base_url": "https://yourcompany.atlassian.net",
    "api_token": "",
    "user_email": "",
    "project_keys": ["PROJ"],
    "developer_account_id": ""
  },
  "claude": {
    "api_key": "",
    "model": "claude-opus-4-5-20251101",
    "stage1_model": "claude-haiku-4-5-20251001"
  }
}
```

Note: Stage 1 summarization (GitHub + Jira) can use a cheaper/faster model like Haiku since it's just compression. Stage 2 (the final enrichment) should use the best available model since quality matters for legal context.

---

## CLI Interface

```bash
# Run full pipeline
node index.js --all

# Run individual stages (useful for debugging or re-running)
node index.js --stage github
node index.js --stage jira
node index.js --stage enrich

# Run on a specific date range (useful for testing on one month first)
node index.js --all --from 2024-03-01 --to 2024-03-31

# Dry run — show what would be enriched without calling Claude
node index.js --all --dry-run
```

---

## Project Structure

```
clockify-enricher/
├── index.js                  # CLI entry point
├── config.json               # gitignored secrets/settings
├── config.example.json       # committed template
├── input/
│   └── clockify-export.csv   # developer drops their export here
├── output/
│   └── enriched-clockify.csv # final output
├── cache/
│   ├── github-summary.json   # stage 1a output (cached so you dont re-fetch)
│   └── jira-summary.json     # stage 1b output (cached)
├── src/
│   ├── github.js             # GitHub API fetching + summarization
│   ├── jira.js               # Jira API fetching + summarization
│   ├── clockify.js           # CSV parsing + output formatting
│   ├── enricher.js           # Stage 2 AI enrichment logic
│   ├── prompts.js            # All AI prompt templates
│   └── utils.js              # Date helpers, fuzzy matching, etc
├── package.json
└── README.md
```

---

## Open Questions for Traycer

These are intentional design decisions left open — Traycer should help spec these out:

1. **What exactly should the GitHub summarizer extract from file paths to determine "modules touched"?** Should it be top-level folders, or go one level deeper?

2. **How should the day-by-day matching handle async work?** For example, a developer works on a feature for 3 days but only merges the PR on day 3 — the Clockify entries from days 1 and 2 have no GitHub event to match against. What's the fallback?

3. **What's the best schema for representing a "split entry" in the output CSV?** Clockify has specific fields — does splitting an entry require duplicating all metadata fields (project, client, tags) exactly?

4. **Should the cache layer be smart enough to do incremental updates?** i.e. if you run it again after adding new Clockify entries, does it re-fetch everything or just the new date range?

5. **How should the tool handle Clockify entries that have zero GitHub or Jira matches?** (e.g. internal calls, research, HR tasks) — these should probably be left mostly as-is with a low confidence flag.

6. **Cost estimation** — before running Stage 2 on the full dataset, should the tool print an estimated token count and ask for confirmation?

---

## Tech Stack

- **Runtime**: Node.js (plain JavaScript, no TypeScript)
- **GitHub API**: Octokit (`@octokit/rest`)
- **Jira API**: REST v3 with axios or node-fetch
- **CSV parsing**: `csv-parse` + `csv-stringify`
- **AI**: Anthropic SDK (`@anthropic-ai/sdk`)
- **Config**: `dotenv` or plain JSON config file

No web framework needed. Pure CLI.

---

## Success Criteria

The tool is successful when:
- Every Clockify entry has a description that a non-technical person can read and understand
- Multi-task entries are split with reasonable time distributions
- Entries involving debugging, rework, or review cycles include explicit mention of why
- The developer can review the output in under 2 hours and make minor corrections rather than writing everything from scratch
- Total hours per day / per project remain exactly unchanged from the input

