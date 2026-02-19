#!/usr/bin/env node

// ============================================================================
// Section 1 — Shebang, Imports, and Constants
// ============================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import readline from "readline";
import { Octokit } from "@octokit/rest";
import { loadConfig } from "../shared/config.js";
import {
  listProviders,
  promptProviderSelection,
  executeProvider,
} from "../shared/cli-provider.js";
import {
  initCache,
  appendToCache,
  writeConsolidatedCache,
  clearCache,
  readCache,
} from "../shared/cache.js";
import { extractTicketIds } from "../shared/ticket-extractor.js";
import { extractModules } from "../shared/module-extractor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

const CACHE_PATH = path.resolve(projectRoot, "cache", "github-summary.ndjson");
const DIRECT_COMMITS_PATH = path.resolve(
  projectRoot,
  "cache",
  "direct-commits.json",
);
const RAW_PR_CACHE_PATH = path.resolve(
  projectRoot,
  "cache",
  "pr-raw-details.json",
);
const GITHUB_PR_PAGE_SIZE = 100;

// ============================================================================
// Section 2 — CLI Argument Parsing
// ============================================================================

const options = {
  "force-refresh": { type: "boolean", short: "f" },
  "use-cache": { type: "boolean" },
  ai: { type: "string" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
};

if (process.argv.includes("--default-params")) {
  const idx = process.argv.indexOf("--default-params");
  process.argv.splice(idx, 1, "--ai", "1", "--use-cache", "--yes");
}

let parsedArgs;
try {
  parsedArgs = parseArgs({ options, strict: false });
} catch (error) {
  console.error(`Failed to parse CLI arguments: ${error.message}`);
  process.exit(1);
}

if (parsedArgs.values.help) {
  console.log(`
github-summarizer — Fetch GitHub PRs and summarize with AI

Usage:
  node github-summarizer.js [options]

Options:
  --force-refresh, -f     Clear cache and fetch fresh data
  --use-cache             Use existing PR cache without prompting
  --ai <number>           Auto-select AI provider by number (e.g. --ai 1)
  --yes, -y               Auto-confirm all prompts
  --help, -h              Show this help message
`);
  process.exit(0);
}

// ============================================================================
// Section 3 — Config Loading & GitHub Credential Validation
// ============================================================================

let config;
try {
  config = await loadConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (!config.github?.personal_access_token) {
  console.error("Missing required field: github.personal_access_token");
  process.exit(1);
}

const octokit = new Octokit({ auth: config.github.personal_access_token });

// ============================================================================
// Section 4 — Direct Commits Check
// ============================================================================

if (!fs.existsSync(DIRECT_COMMITS_PATH)) {
  console.warn(
    "Warning: cache/direct-commits.json not found. Run collect-direct-commits.js first for complete data.",
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let answer;
  if (parsedArgs.values.yes) {
    console.log("Continue anyway? (y/n) y (auto)");
    answer = "y";
  } else {
    answer = await new Promise((resolve) => {
      rl.question("Continue anyway? (y/n) ", (a) => { rl.close(); resolve(a); });
    });
  }

  if (answer.toLowerCase() !== "y") {
    console.log("Check workflow order. Run collect-direct-commits.js first.");
    process.exit(1);
  }
}

// ============================================================================
// Section 5 — Force Refresh
// ============================================================================

if (parsedArgs.values["force-refresh"]) {
  clearCache(CACHE_PATH);
  clearCache(RAW_PR_CACHE_PATH);
  console.log("Cache cleared.");
}

// ============================================================================
// Section 5b — Raw PR Cache Check
// ============================================================================

let useRawCache = false;

if (!parsedArgs.values["force-refresh"] && fs.existsSync(RAW_PR_CACHE_PATH)) {
  const rawCacheFile = JSON.parse(fs.readFileSync(RAW_PR_CACHE_PATH, "utf-8"));
  const rawCacheData = Array.isArray(rawCacheFile)
    ? rawCacheFile
    : (rawCacheFile.prs ?? []);
  const N = rawCacheData.length;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let answer;
  if (parsedArgs.values["use-cache"] || parsedArgs.values["force-refresh"]) {
    answer = parsedArgs.values["force-refresh"] ? "r" : "c";
    console.log(`Found cached PR data (${N} PRs). Use (C)ache or (R)e-fetch from GitHub? (c/r): ${answer} (auto)`);
  } else {
    answer = await new Promise((resolve) => {
      rl.question(
        `Found cached PR data (${N} PRs). Use (C)ache or (R)e-fetch from GitHub? (c/r): `,
        (a) => { rl.close(); resolve(a); },
      );
    });
  }

  if (answer.toLowerCase() === "c") {
    useRawCache = true;
  } else {
    clearCache(RAW_PR_CACHE_PATH);
    clearCache(CACHE_PATH);
  }
}

// ============================================================================
// Section 6 — AI Provider Selection
// ============================================================================

const providers = listProviders();
if (providers.length === 0) {
  console.error(
    "No AI providers found in cli-providers/. Add a provider script first.",
  );
  process.exit(1);
}

const selectedProvider = await promptProviderSelection(providers, parsedArgs.values.ai ?? null);

// ============================================================================
// Section 7 — Cache Initialization (Resume Support)
// ============================================================================

const cachedItems = await initCache(CACHE_PATH);
const processedShas = new Set(
  cachedItems.filter((i) => i.sha).map((i) => i.sha),
);

if (processedShas.size > 0) {
  console.log(
    `Resuming from cache: ${processedShas.size} commits already processed.`,
  );
}

// Drop legacy (non-commit) records from the NDJSON file before proceeding
if (!parsedArgs.values["force-refresh"]) {
  const validCachedItems = cachedItems.filter((i) => i.sha && !i.type);
  if (validCachedItems.length < cachedItems.length) {
    console.log(
      `Dropping ${cachedItems.length - validCachedItems.length} legacy cache entries from NDJSON.`,
    );
    const ndjsonContent =
      validCachedItems.length > 0
        ? validCachedItems.map((i) => JSON.stringify(i)).join("\n") + "\n"
        : "";
    fs.writeFileSync(CACHE_PATH, ndjsonContent);
  }
}

// ============================================================================
// Section 8 — Helper Functions (Script Phase)
// ============================================================================

function extractJiraTicketLinks(text) {
  const regex = /\/browse\/([A-Z]{2,10}-\d+)/g;
  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}

function mergeTicketIds(...arrays) {
  const merged = new Set();
  for (const arr of arrays) {
    if (Array.isArray(arr)) {
      for (const id of arr) {
        merged.add(id);
      }
    }
  }
  return Array.from(merged);
}

// ============================================================================
// Section 9 — PR Fetching (Script Phase)
// ============================================================================

async function fetchAllPRs(octokit, config) {
  const allPRs = [];

  try {
    const q = `repo:${config.github.repo_owner}/${config.github.repo_name} is:pr is:merged merged:${config.github.date_from}..${config.github.date_to}`;

    // Use the Search API to reliably find PRs in the date range
    const searchResults = await octokit.paginate(
      octokit.search.issuesAndPullRequests,
      { q, per_page: GITHUB_PR_PAGE_SIZE },
    );

    // searchResults contains issue/PR-like items; fetch full PR details for each
    let prCount = 0;
    for (let i = 0; i < searchResults.length; i++) {
      const item = searchResults[i];
      const prNumber = item.number;

      try {
        const { data: pr } = await octokit.pulls.get({
          owner: config.github.repo_owner,
          repo: config.github.repo_name,
          pull_number: prNumber,
        });

        // Only consider merged PRs (search already filtered, but double-check)
        if (!pr.merged_at) continue;

        allPRs.push(pr);
        prCount++;
        process.stdout.write(`\rFetching PRs... ${prCount}`);
      } catch (err) {
        throw err;
      }
    }
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      if (
        error.status === 403 &&
        error.response?.headers?.["x-ratelimit-remaining"] === "0"
      ) {
        console.error(
          "\nGitHub rate limit exceeded. Wait and retry, or use --force-refresh to restart.",
        );
      } else {
        console.error(
          "\nGitHub authentication failed. Check personal_access_token in config.",
        );
      }
    } else {
      throw error;
    }
    process.exit(1);
  }

  console.log("");
  return allPRs;
}

// ============================================================================
// Section 10 — PR Detail Fetching (Script Phase)
// ============================================================================

async function fetchPRDetails(octokit, config, prNumber, developerEmails = []) {
  const commits = await octokit.paginate(octokit.pulls.listCommits, {
    owner: config.github.repo_owner,
    repo: config.github.repo_name,
    pull_number: prNumber,
    per_page: 100,
  });

  const files = await octokit.paginate(octokit.pulls.listFiles, {
    owner: config.github.repo_owner,
    repo: config.github.repo_name,
    pull_number: prNumber,
    per_page: 100,
  });

  const reviews = await octokit.paginate(octokit.pulls.listReviews, {
    owner: config.github.repo_owner,
    repo: config.github.repo_name,
    pull_number: prNumber,
    per_page: 100,
  });

  const commit_details = {};
  for (const commit of commits) {
    const isDevCommit =
      developerEmails.length === 0 ||
      (!!commit.commit?.author?.email &&
        developerEmails.includes(commit.commit.author.email.toLowerCase()));
    if (isDevCommit) {
      const { data } = await octokit.repos.getCommit({
        owner: config.github.repo_owner,
        repo: config.github.repo_name,
        ref: commit.sha,
      });
      commit_details[commit.sha] = {
        files: data.files ?? [],
        lines_added: (data.files ?? []).reduce(
          (sum, f) => sum + f.additions,
          0,
        ),
        lines_removed: (data.files ?? []).reduce(
          (sum, f) => sum + f.deletions,
          0,
        ),
      };
    }
  }

  return { commits, files, reviewCount: reviews.length, commit_details };
}

// ============================================================================
// Section 12 — AI Summarization (AI Phase)
// ============================================================================

async function summarizePRContext(pr, details, selectedProvider) {
  const commitMessages = (details.commits || [])
    .map((c) => c.commit.message)
    .join("\n---\n");
  const filesChanged = (details.files || []).map((f) => f.filename).join(", ");
  const modulesTouched = extractModules(
    (details.files || []).map((f) => f.filename),
  ).join(", ");

  const prompt = `Analyze the following GitHub PR and provide a short paragraph describing what was built across the whole PR. Focus on WHAT WAS BUILT based on the code changes.

PR #${pr.number}: ${pr.title}

Commit messages:
${commitMessages}

Files changed:
${filesChanged}

Modules touched:
${modulesTouched}

Provide a concise JSON response:
{
  "pr_ai_description": "Short paragraph describing what was built across this PR"
}

Respond ONLY with valid JSON, no markdown fences.`;

  const result = await executeProvider(selectedProvider, prompt);
  let jsonResponse = result.response;

  jsonResponse = jsonResponse.replace(/```json\n?/g, "").replace(/```\n?/g, "");

  const parsed = JSON.parse(jsonResponse);
  return parsed.pr_ai_description;
}

async function summarizeCommit(
  commitData,
  prContext,
  selectedProvider,
  projectKeys = [],
) {
  const prompt = `Summarize the following GitHub commit for time-tracking enrichment. Focus on WHAT WAS BUILT based on the code changes.

Commit: ${commitData.sha}
Date: ${commitData.committed_at}
Message: ${commitData.message}

Files changed:
${commitData.files_changed.join(", ")}

Modules touched:
${commitData.modules_touched.join(", ")}

Lines added: ${commitData.lines_added}
Lines removed: ${commitData.lines_removed}

PR Context (PR #${prContext.pr_number}: ${prContext.pr_title}):
${prContext.pr_ai_description}

Provide a concise JSON response:
{
  "ai_description": "Brief description of what was built in this specific commit"
}

Respond ONLY with valid JSON, no markdown fences.`;

  const result = await executeProvider(selectedProvider, prompt);
  let jsonResponse = result.response;

  jsonResponse = jsonResponse.replace(/```json\n?/g, "").replace(/```\n?/g, "");

  const parsed = JSON.parse(jsonResponse);
  return parsed.ai_description;
}

async function summarizeOrphanCommit(
  commitData,
  selectedProvider,
  projectKeys = [],
) {
  const prompt = `Summarize the following direct commit for time-tracking enrichment. Focus on WHAT WAS BUILT based on the code changes.

Commit: ${commitData.sha}
Date: ${commitData.committed_at}
Message: ${commitData.message}

Files changed:
${commitData.files_changed.join(", ")}

Modules touched:
${commitData.modules_touched.join(", ")}

Lines added: ${commitData.lines_added}
Lines removed: ${commitData.lines_removed}

Provide a concise JSON response:
{
  "ai_description": "Brief description of what was built in this commit"
}

Respond ONLY with valid JSON, no markdown fences.`;

  const result = await executeProvider(selectedProvider, prompt);
  let jsonResponse = result.response;

  jsonResponse = jsonResponse.replace(/```json\n?/g, "").replace(/```\n?/g, "");

  const parsed = JSON.parse(jsonResponse);
  return parsed.ai_description;
}

// ============================================================================
// Section 13 — Main Orchestration IIFE
// ============================================================================

(async () => {
  try {
    // Step A — Fetch all PRs
    let allPRs;
    let allPRDetails = {};
    let cachedDeveloperEmails = [];

    if (useRawCache) {
      const rawCacheFile = JSON.parse(
        fs.readFileSync(RAW_PR_CACHE_PATH, "utf-8"),
      );
      const rawCacheData = Array.isArray(rawCacheFile)
        ? rawCacheFile
        : (rawCacheFile.prs ?? []);
      cachedDeveloperEmails = Array.isArray(rawCacheFile.developer_emails)
        ? rawCacheFile.developer_emails
        : [];
      allPRs = rawCacheData.map((entry) => ({
        number: entry.pr_number,
        title: entry.pr_title,
        merged_at: entry.merged_at,
        merge_commit_sha: entry.merge_commit_sha,
        body: entry.body,
      }));
      for (const entry of rawCacheData) {
        allPRDetails[entry.pr_number] = {
          commits: entry.commits,
          files: entry.files,
          reviewCount: entry.reviewCount,
          commit_details: entry.commit_details ?? {},
        };
      }
      console.log(`Loaded ${allPRs.length} PRs from raw cache.`);
    } else {
      allPRs = await fetchAllPRs(octokit, config);
    }

    // Resolve developerEmails: use config.github.developer_emails if present,
    // otherwise fall back to the authenticated user's email (normalized to lowercase)
    let developerEmails = [];
    if (
      Array.isArray(config.github?.developer_emails) &&
      config.github.developer_emails.length > 0
    ) {
      developerEmails = config.github.developer_emails.map((e) =>
        e.toLowerCase(),
      );
    } else {
      if (!useRawCache) {
        try {
          const auth = await octokit.users.getAuthenticated();
          const email = auth?.data?.email;
          if (email) developerEmails = [email.toLowerCase()];
        } catch (err) {
          // Unable to determine authenticated user's email; leave developerEmails empty
          developerEmails = [];
        }
      } else {
        // In cache mode, restore emails persisted during the original fetch
        developerEmails = cachedDeveloperEmails;
      }
    }

    if (allPRs.length === 0) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      let answer;
      if (parsedArgs.values.yes) {
        console.log("No GitHub PRs found in date range. Continue anyway? (y/n) y (auto)");
        answer = "y";
      } else {
        answer = await new Promise((resolve) => {
          rl.question(
            "No GitHub PRs found in date range. Continue anyway? (y/n) ",
            (a) => { rl.close(); resolve(a); },
          );
        });
      }

      if (answer.toLowerCase() !== "y") {
        console.log("Check config.json github settings.");
        process.exit(1);
      }
    }

    // Step B — Fetch PR details for all PRs (to build complete prShaSet)
    const enrichedPRs = [];

    if (useRawCache) {
      for (const pr of allPRs) {
        const details = allPRDetails[pr.number];
        // Ownership filter: include PR only if it has at least one commit authored by developerEmails
        let includePR = true;
        if (Array.isArray(developerEmails) && developerEmails.length > 0) {
          includePR = (details.commits || []).some(
            (c) =>
              !!c.commit?.author?.email &&
              developerEmails.includes(c.commit.author.email.toLowerCase()),
          );
        }
        if (includePR) {
          enrichedPRs.push({ ...pr, ...details });
        }
      }
    } else {
      for (let i = 0; i < allPRs.length; i++) {
        const pr = allPRs[i];
        const details = await fetchPRDetails(
          octokit,
          config,
          pr.number,
          developerEmails,
        );
        allPRDetails[pr.number] = details;
        // Ownership filter: include PR only if it has at least one commit authored by developerEmails
        let includePR = true;
        if (Array.isArray(developerEmails) && developerEmails.length > 0) {
          includePR = (details.commits || []).some(
            (c) =>
              !!c.commit?.author?.email &&
              developerEmails.includes(c.commit.author.email.toLowerCase()),
          );
        }
        if (includePR) {
          enrichedPRs.push({ ...pr, ...details });
        }
        process.stdout.write(
          `\rFetching PR details... ${i + 1}/${allPRs.length}`,
        );
      }

      console.log("");

      // Write raw PR cache after fresh fetch
      const rawCacheEntries = allPRs.map((pr) => ({
        pr_number: pr.number,
        pr_title: pr.title,
        merged_at: pr.merged_at,
        merge_commit_sha: pr.merge_commit_sha,
        body: pr.body,
        commits: allPRDetails[pr.number]?.commits ?? [],
        files: allPRDetails[pr.number]?.files ?? [],
        reviewCount: allPRDetails[pr.number]?.reviewCount ?? 0,
        commit_details: allPRDetails[pr.number]?.commit_details ?? {},
      }));
      fs.writeFileSync(
        RAW_PR_CACHE_PATH,
        JSON.stringify(
          { developer_emails: developerEmails, prs: rawCacheEntries },
          null,
          2,
        ),
      );
    }

    // Step C — Load direct commits & SHA subtraction
    let allDirectCommits = [];
    if (fs.existsSync(DIRECT_COMMITS_PATH)) {
      allDirectCommits = JSON.parse(
        fs.readFileSync(DIRECT_COMMITS_PATH, "utf-8"),
      );
      console.log("Loaded main-branch developer commits from cache");
    }

    const prShaSet = new Set();
    for (const pr of allPRs) {
      const details = allPRDetails[pr.number];
      if (details && details.commits) {
        for (const commit of details.commits) {
          prShaSet.add(commit.sha);
        }
      }
      if (pr.merge_commit_sha) {
        prShaSet.add(pr.merge_commit_sha);
      }
    }

    const directCommitCandidates = allDirectCommits.filter(
      (c) => !prShaSet.has(c.sha),
    );

    console.log(
      `Identified ${directCommitCandidates.length} direct commit candidates after subtracting PR-associated SHAs`,
    );

    // Step E — Build PR-level context map
    const prContextMap = {};
    for (const pr of enrichedPRs) {
      try {
        prContextMap[pr.number] = await summarizePRContext(
          pr,
          allPRDetails[pr.number],
          selectedProvider,
        );
      } catch (error) {
        console.warn(
          `\nWarning: Failed to summarize PR #${pr.number} context: ${error.message}`,
        );
        prContextMap[pr.number] = pr.title;
      }
    }

    // Step F — Per-commit summaries for PR commits
    const totalPRCommits = enrichedPRs.reduce((sum, pr) => {
      const details = allPRDetails[pr.number];
      const devCommits = (details.commits || []).filter(
        (c) =>
          developerEmails.length === 0 ||
          (!!c.commit?.author?.email &&
            developerEmails.includes(c.commit.author.email.toLowerCase())),
      );
      return sum + devCommits.length;
    }, 0);

    const totalCommits = totalPRCommits + directCommitCandidates.length;
    let processedCount = 0;

    for (const pr of enrichedPRs) {
      const details = allPRDetails[pr.number];
      const projectKeys = config.jira?.project_keys ?? [];

      for (const commit of details.commits) {
        const isDevCommit =
          developerEmails.length === 0 ||
          (!!commit.commit?.author?.email &&
            developerEmails.includes(commit.commit.author.email.toLowerCase()));
        if (!isDevCommit) continue;

        if (processedShas.has(commit.sha)) continue;

        let commitDetail = details.commit_details?.[commit.sha];
        if (!commitDetail) {
          // Fetch on-the-fly (old cache fallback)
          const { data } = await octokit.repos.getCommit({
            owner: config.github.repo_owner,
            repo: config.github.repo_name,
            ref: commit.sha,
          });
          commitDetail = {
            files: data.files ?? [],
            lines_added: (data.files ?? []).reduce(
              (sum, f) => sum + f.additions,
              0,
            ),
            lines_removed: (data.files ?? []).reduce(
              (sum, f) => sum + f.deletions,
              0,
            ),
          };
        }

        const ticket_ids = mergeTicketIds(
          extractTicketIds(commit.commit.message, projectKeys),
          extractJiraTicketLinks(commit.commit.message),
        );
        const modules_touched = extractModules(
          commitDetail.files.map((f) => f.filename),
        );

        const commitData = {
          sha: commit.sha,
          committed_at: commit.commit.author.date,
          message: commit.commit.message,
          files_changed: commitDetail.files.map((f) => f.filename),
          modules_touched,
          lines_added: commitDetail.lines_added,
          lines_removed: commitDetail.lines_removed,
        };

        const prAiDescription = prContextMap[pr.number];
        const prContext = {
          pr_number: pr.number,
          pr_title: pr.title,
          pr_ai_description: prAiDescription,
        };

        try {
          const ai_description = await summarizeCommit(
            commitData,
            prContext,
            selectedProvider,
            projectKeys,
          );

          const record = {
            sha: commit.sha,
            committed_at: commitData.committed_at,
            message: commitData.message,
            files_changed: commitData.files_changed,
            modules_touched,
            lines_added: commitDetail.lines_added,
            lines_removed: commitDetail.lines_removed,
            ticket_ids,
            ai_description,
            pr_context: {
              pr_number: pr.number,
              pr_title: pr.title,
              pr_ai_description: prAiDescription,
            },
          };

          await appendToCache(CACHE_PATH, record);
          processedCount++;
          process.stdout.write(
            `\rSummarizing commits... ${processedCount}/${totalCommits}`,
          );
        } catch (error) {
          console.warn(
            `\nWarning: Failed to process commit ${commit.sha}: ${error.message}`,
          );
        }
      }
    }

    // Step G — Per-commit summaries for orphan commits
    for (const commit of directCommitCandidates) {
      if (processedShas.has(commit.sha)) continue;

      const projectKeys = config.jira?.project_keys ?? [];
      const ticket_ids = mergeTicketIds(
        extractTicketIds(commit.message, projectKeys),
        extractJiraTicketLinks(commit.message),
      );

      const commitData = {
        sha: commit.sha,
        committed_at: commit.date,
        message: commit.message,
        files_changed: commit.files_changed ?? [],
        modules_touched: commit.modules_touched ?? [],
        lines_added: commit.lines_added ?? 0,
        lines_removed: commit.lines_removed ?? 0,
      };

      try {
        const ai_description = await summarizeOrphanCommit(
          commitData,
          selectedProvider,
          projectKeys,
        );

        const record = {
          sha: commit.sha,
          committed_at: commit.date,
          message: commit.message,
          files_changed: commit.files_changed ?? [],
          modules_touched: commit.modules_touched ?? [],
          lines_added: commit.lines_added ?? 0,
          lines_removed: commit.lines_removed ?? 0,
          ticket_ids,
          ai_description,
          pr_context: null,
        };

        await appendToCache(CACHE_PATH, record);
        processedCount++;
        process.stdout.write(
          `\rSummarizing commits... ${processedCount}/${totalCommits}`,
        );
      } catch (error) {
        console.warn(
          `\nWarning: Failed to process commit ${commit.sha}: ${error.message}`,
        );
      }
    }

    // Step H — Consolidated cache write & summary
    console.log("");

    const allItems = (await readCache(CACHE_PATH)).filter(
      (i) => i.sha && !i.type,
    );
    await writeConsolidatedCache(CACHE_PATH, allItems);

    if (allItems.length === 0) {
      console.log("No GitHub data found. Check config.");
    } else {
      console.log(
        `Processed ${allItems.length} commits (${totalPRCommits} from PRs, ${directCommitCandidates.length} orphan). Output: cache/github-summary.json`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
})();
