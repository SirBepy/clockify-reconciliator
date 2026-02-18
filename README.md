# Clockify Reconciliator

## Overview

This tool automatically enriches vague Clockify time entries using GitHub commit history and Jira ticket data to produce legally defensible time records. Rather than manually rewriting descriptions, the reconciliator connects each entry to actual code changes and ticket history, then uses AI to generate professional, accurate descriptions backed by real work artifacts.

Entries are enriched with detailed context while preserving the original total hours — no time is added or removed from any entry or day. The result is a set of legally defensible records suitable for client submission or internal audit.

---

## Prerequisites

- **Node.js**: v18 or later (required for built-in `parseArgs` and ESM support).

- **GitHub Personal Access Token (PAT)**: create at **Settings → Developer settings → Personal access tokens**. Required scopes:
  - `repo` (or `public_repo` for public repositories)
  - `user:email` (used to auto-detect developer email if `developer_emails` is not set in config)

- **Jira API Token**: generate at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens). Used with Basic Auth (`user_email:api_token`).

- **AI Provider API Keys**: set in `config.json` under the `ai` section (`ai.anthropic_api_key` for Claude models, `ai.gemini_api_key` for Gemini models). See Setup step 3.

---

## Setup

1. Clone the repository.
2. Run `npm install`.
3. Copy `config.example.json` to `config.json` and fill in all credentials and date ranges. API keys for AI providers go in the `ai` section (`ai.anthropic_api_key` for Claude, `ai.gemini_api_key` for Gemini).
4. Export a **Detailed Report** from Clockify (not a summary report) as CSV and place it in `input/` (e.g., `input/clockify-export.csv`). The CSV must contain columns: `Description`, `Start Date`, `Start Time`, `End Date`, `End Time`, `Duration (h)`.

The `input/`, `output/`, and `cache/` directories are pre-created in the repo (via `.gitkeep` files) and will be used by the tools at runtime. The tools also create them automatically if they are missing.

---

## Workflow Order

Run the tools in this order. Each step is idempotent — re-running a step (without `--force-refresh`) uses cached results:

```
1. node clockify-preprocessor.js      # Clean the Clockify CSV → cache/clockify-cleaned.csv
2. node collect-direct-commits.js     # Fetch main-branch commits → cache/direct-commits.json
3. node github-summarizer.js          # Fetch PRs + AI summaries → cache/github-summary.json
4. node jira-summarizer.js            # Fetch tickets + AI summaries → cache/jira-summary.json
5. node clockify-enricher.js          # Detect patterns + enrich entries → output/
```

Steps 3–5 prompt for AI provider selection interactively.

---

## CLI Flags Per Tool

| Flag                     | Tool(s)                         | Description                                       |
| ------------------------ | ------------------------------- | ------------------------------------------------- |
| `--input <path>` / `-i`  | `clockify-preprocessor.js` only | Override input CSV path (overrides `config.json`) |
| `--force-refresh` / `-f` | All tools                       | Clear this tool's cache and start fresh           |
| `--help` / `-h`          | All tools                       | Print usage and exit                              |

**Note on `--force-refresh` scope for the enricher**: `clockify-enricher.js --force-refresh` clears only `cache/patterns.json` and `cache/enrichment-progress.ndjson`. The GitHub and Jira caches (`cache/github-summary.json` and `cache/jira-summary.json`) are **not** cleared; to refresh those, run `github-summarizer.js --force-refresh` or `jira-summarizer.js --force-refresh` separately.

---

## AI Provider Management

### Built-in Providers

The tool includes five providers in `cli-providers/`:

- **Claude models** (configured via `config.json` `ai.anthropic_api_key`):
  - `claude-opus` — most capable, higher cost
  - `claude-sonnet` — balanced performance/cost
  - `claude-haiku` — fastest, lowest cost

- **Gemini models** (configured via `config.json` `ai.gemini_api_key`):
  - `gemini-pro` — most capable, higher cost
  - `gemini-flash` — fast, lower cost

**Note:** Environment variables (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`) still work as overrides if set — they take precedence over `config.json` values.

### Adding a Custom Provider

To use a custom AI model:

1. Create a new file `cli-providers/your-provider.js` in the `cli-providers/` directory.
2. The tool will auto-discover it and show it in the selection menu.

**File-in / File-out Contract:**

The tool calls:

```bash
node cli-providers/your-provider.js <promptFile> <responseFile>
```

Your provider script must:

1. Read the prompt from `<promptFile>` (passed as `process.argv[2]`)
2. Call your AI model with the prompt
3. Write the model's response text to `<responseFile>` (passed as `process.argv[3]`)
4. **(Optional)** Write token usage metadata to `<responseFile>.meta.json` (e.g., `{ "input_tokens": 150, "output_tokens": 200 }`) for token estimation refinement

**Minimal custom provider skeleton:**

```javascript
import fs from "fs";

const promptFile = process.argv[2];
const responseFile = process.argv[3];

async function main() {
  // 1. Read the prompt
  const prompt = fs.readFileSync(promptFile, "utf-8");

  // 2. Call your model (pseudo-code)
  const response = await callYourModel(prompt);

  // 3. Write the response
  fs.writeFileSync(responseFile, response.text, "utf-8");

  // Optional: write token metadata
  fs.writeFileSync(
    `${responseFile}.meta.json`,
    JSON.stringify({
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    }),
  );
}

main();
```

---

## Output Files

| File                               | Purpose                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `output/enriched-mirrored.csv`     | Matches the input Clockify schema — safest for legal/client submission             |
| `output/enriched-standardized.csv` | Adds `AI_Confidence`, `AI_Notes`, `Split_Group_ID` columns — use for manual review |
| `output/diff.txt`                  | Side-by-side original vs enriched descriptions — audit trail                       |

---

## Troubleshooting

| Symptom                                          | Cause                                                      | Fix                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Config file not found`                          | `config.json` missing                                      | Copy `config.example.json` → `config.json`                                                       |
| `CSV missing required columns`                   | Wrong Clockify export type                                 | Export **Detailed Report** (not summary) from Clockify                                           |
| `cache/direct-commits.json not found`            | Steps run out of order                                     | Run `collect-direct-commits.js` before `github-summarizer.js`                                    |
| `Run [tool] first`                               | Missing cache dependency                                   | Follow the 5-step workflow order                                                                 |
| `GitHub rate limit exceeded`                     | Too many API calls                                         | Wait ~1 hour, then re-run. If PR data was already fetched, choose `c` to skip re-fetching.       |
| `GitHub authentication failed`                   | Bad PAT                                                    | Check `github.personal_access_token` in `config.json`; verify PAT scopes (`repo` + `user:email`) |
| `Jira API error: 401`                            | Bad Jira credentials                                       | Verify `jira.user_email` and `jira.api_token` in `config.json`                                   |
| `ANTHROPIC_API_KEY environment variable not set` | Missing API key                                            | Set `ai.anthropic_api_key` in `config.json`                                                      |
| `GOOGLE_API_KEY environment variable not set`    | Missing API key                                            | Set `ai.gemini_api_key` in `config.json`                                                         |
| `No AI providers found in cli-providers/`        | `cli-providers/` empty or missing `.js` files              | Ensure provider scripts exist and are readable                                                   |
| Date range mismatch prompt                       | Clockify CSV covers dates outside GitHub/Jira config range | Update `date_from`/`date_to` in `config.json` and re-run summarizers                             |
| `Found partial cache. Resume or start fresh?`    | Tool was interrupted mid-run                               | Enter `r` to resume from the last successful item                                                |

---

## Architecture Principle

> "Scripts collect data, AI adds intelligence."

- **Data fetching** (GitHub API, Jira API, CSV parsing) is pure scripting — deterministic, free, fast.
- **Grouping, summarization, pattern detection, and description writing** use AI — where quality and professional language matter for legal defensibility.

---

## Legal Defensibility

- **Total hours preserved**: the enricher never changes the sum of hours per day or in aggregate. Every enriched record has the same duration as the original.
- **Deterministic splitting**: when one entry is split into sub-tasks, timestamps are divided sequentially (first sub-entry keeps original start; each next starts at previous end; last ends at original end). Same input always produces same output.
- **Audit trail**: `output/diff.txt` shows every original description alongside its enriched version, enabling easy manual verification.
- **Confidence flagging**: `AI_Confidence` (high/medium/low) in the standardized CSV lets reviewers focus manual effort on low-confidence entries.
- **No fabrication**: AI descriptions are grounded in actual GitHub commit messages, file changes, and Jira ticket data — never invented or speculative.

---

## Testing / Validation Checklist

Since this tool operates on private real data that cannot be committed to the repo, follow these manual E2E validation steps:

1. **Happy path**: run all 5 steps in order; verify `output/enriched-mirrored.csv` and `output/enriched-standardized.csv` exist; sum `Duration (h)` column in input and output — totals must match exactly.

2. **Hours preservation**: open both CSVs in a spreadsheet; group by date; confirm per-day totals are identical to the original.

3. **Split entries**: find a multi-task entry in the original (e.g., "Tasks 361, 480 + Build"); confirm it appears as multiple rows in output with sequential timestamps and the same total duration.

4. **Confidence distribution**: check `AI_Confidence` column; target ≥80% high/medium entries.

5. **Date range mismatch**: temporarily set `github.date_from` to a date after the Clockify CSV range; run enricher; confirm the mismatch prompt appears.

6. **Resume after interruption**: kill `github-summarizer.js` mid-run (Ctrl+C); re-run without `--force-refresh`; confirm it resumes from where it stopped (not from the beginning).

7. **Force refresh**: run `clockify-enricher.js --force-refresh`; confirm `cache/patterns.json` is regenerated but `cache/github-summary.json` and `cache/jira-summary.json` are untouched.

8. **Missing cache**: delete `cache/direct-commits.json`; run `github-summarizer.js`; confirm the warning and continue/exit prompt appears.

9. **Invalid CSV**: run `clockify-preprocessor.js` with a summary (non-detailed) Clockify export; confirm the "CSV missing required columns" error.

10. **Bad credentials**: set a wrong `api_token` in `config.json`; run `jira-summarizer.js`; confirm a clear auth error message.
