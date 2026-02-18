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
import { loadConfig } from "./src/shared/config.js";
import {
  listProviders,
  promptProviderSelection,
  executeProvider,
} from "./src/shared/cli-provider.js";
import {
  initCache,
  appendToCache,
  writeConsolidatedCache,
  clearCache,
  readCache,
} from "./src/shared/cache.js";
import { extractTicketIds } from "./src/shared/ticket-extractor.js";
import { extractModules } from "./src/shared/module-extractor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;

const CACHE_PATH = path.resolve(projectRoot, "cache", "github-summary.ndjson");
const DIRECT_COMMITS_PATH = path.resolve(
  projectRoot,
  "cache",
  "direct-commits.json",
);
const GITHUB_PR_PAGE_SIZE = 100;

// ============================================================================
// Section 2 — CLI Argument Parsing
// ============================================================================

const options = {
  "force-refresh": {
    type: "boolean",
    short: "f",
  },
  help: {
    type: "boolean",
    short: "h",
  },
};

let parsedArgs;
try {
  parsedArgs = parseArgs({ options });
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

  const answer = await new Promise((resolve) => {
    rl.question("Continue anyway? (y/n) ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });

  if (answer.toLowerCase() !== "y") {
    console.log("Check workflow order. Run collect-direct-commits.js first.");
    process.exit(0);
  }
}

// ============================================================================
// Section 5 — Force Refresh
// ============================================================================

if (parsedArgs.values["force-refresh"]) {
  clearCache(CACHE_PATH);
  console.log("Cache cleared.");
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

const selectedProvider = await promptProviderSelection(providers);

// ============================================================================
// Section 7 — Cache Initialization (Resume Support)
// ============================================================================

const cachedItems = await initCache(CACHE_PATH);
const processedPrNumbers = new Set(
  cachedItems.filter((i) => i.type === "pr").map((i) => i.pr_number),
);
const commitGroupsDone = cachedItems.some((i) => i.type === "commit_group");

if (processedPrNumbers.size > 0) {
  console.log(
    `Resuming from cache: ${processedPrNumbers.size} PRs already processed.`,
  );
}

// ============================================================================
// Section 8 — Helper Functions (Script Phase)
// ============================================================================

function computeComplexitySignal(filesChangedCount) {
  if (filesChangedCount < 5) return "low";
  if (filesChangedCount <= 15) return "medium";
  return "high";
}

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

async function fetchPRDetails(octokit, config, prNumber) {
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

  return { commits, files, reviewCount: reviews.length };
}

// ============================================================================
// Section 11 — AI Semantic Grouping (AI Phase)
// ============================================================================

async function groupDirectCommits(directCommitCandidates, selectedProvider) {
  const commitsList = directCommitCandidates
    .map(
      (c) =>
        `SHA: ${c.sha}\nDate: ${c.date}\nMessage: ${c.message}\nFiles: ${c.files_changed.join(", ")}\nModules: ${c.modules_touched.join(", ")}`,
    )
    .join("\n---\n");

  const prompt = `Analyze and group the following direct commits by semantic relatedness (same feature, bug, or module):

${commitsList}

Return a JSON array of groups. Each group should have:
{
  "date": "YYYY-MM-DD",
  "commits": [{"sha": "...", "message": "..."}],
  "files_changed": ["path1", "path2"],
  "modules_touched": ["module1", "module2"],
  "ticket_ids": ["ID1", "ID2"]
}

Extract ticket IDs from commit messages using patterns like SD-123 or JIRA-456.
Group related commits together. Respond ONLY with valid JSON, no markdown fences.`;

  const result = await executeProvider(selectedProvider, prompt);
  let jsonResponse = result.response;

  jsonResponse = jsonResponse.replace(/```json\n?/g, "").replace(/```\n?/g, "");

  const parsed = JSON.parse(jsonResponse);
  return parsed;
}

// ============================================================================
// Section 12 — AI Summarization (AI Phase)
// ============================================================================

async function summarizePR(pr, details, selectedProvider, developerEmails) {
  // Filter commits to only those authored by developerEmails (if available)
  const devEmails = Array.isArray(developerEmails) ? developerEmails : [];
  let relevantCommits = details.commits;
  if (devEmails.length > 0) {
    const filtered = details.commits.filter(
      (c) =>
        !!c.commit?.author?.email &&
        devEmails.includes(c.commit.author.email.toLowerCase()),
    );
    if (filtered.length > 0) relevantCommits = filtered;
  }

  const commitMessages = relevantCommits
    .map((c) => c.commit.message)
    .join("\n---\n");
  const filesChanged = details.files.map((f) => f.filename).join(", ");
  const modulesTouched = extractModules(
    details.files.map((f) => f.filename),
  ).join(", ");
  const filesChangedCount = details.files.length;
  const complexitySignal = computeComplexitySignal(filesChangedCount);

  const prompt = `Summarize the following GitHub PR for time-tracking enrichment. Focus on WHAT WAS BUILT based on the code changes, NOT the PR description.

PR #${pr.number}: ${pr.title}
Complexity: ${complexitySignal}
Files changed: ${filesChangedCount}
Reviews: ${details.reviewCount}

Commit messages:
${commitMessages}

Files modified:
${filesChanged}

Modules touched:
${modulesTouched}

Provide a concise JSON response:
{
  "ai_description": "Brief description of what was built based on code changes"
}

Respond ONLY with valid JSON, no markdown fences.`;

  const result = await executeProvider(selectedProvider, prompt);
  let jsonResponse = result.response;

  jsonResponse = jsonResponse.replace(/```json\n?/g, "").replace(/```\n?/g, "");

  const parsed = JSON.parse(jsonResponse);
  return parsed.ai_description;
}

async function summarizeCommitGroup(group, selectedProvider) {
  const commitMessages = group.commits.map((c) => c.message).join("\n---\n");
  const filesChanged = group.files_changed.join(", ");
  const modulesTouched = group.modules_touched.join(", ");

  const prompt = `Summarize the following group of related direct commits for time-tracking enrichment.

Date: ${group.date}
Commits:
${commitMessages}

Files modified:
${filesChanged}

Modules touched:
${modulesTouched}

Provide a concise JSON response:
{
  "ai_description": "Brief description of what was built based on these commits"
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
    const allPRs = await fetchAllPRs(octokit, config);

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
      try {
        const auth = await octokit.users.getAuthenticated();
        const email = auth?.data?.email;
        if (email) developerEmails = [email.toLowerCase()];
      } catch (err) {
        // Unable to determine authenticated user's email; leave developerEmails empty
        developerEmails = [];
      }
    }

    if (allPRs.length === 0) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise((resolve) => {
        rl.question(
          "No GitHub PRs found in date range. Continue anyway? (y/n) ",
          (answer) => {
            rl.close();
            resolve(answer);
          },
        );
      });

      if (answer.toLowerCase() !== "y") {
        console.log("Check config.json github settings.");
        process.exit(0);
      }
    }

    // Step B — Fetch PR details for all PRs (to build complete prShaSet)
    const newPRCandidates = allPRs.filter(
      (pr) => !processedPrNumbers.has(pr.number),
    );
    const allPRDetails = {};
    const enrichedPRs = [];

    // Fetch details for all PRs (both new and cached)
    for (let i = 0; i < allPRs.length; i++) {
      const pr = allPRs[i];
      const details = await fetchPRDetails(octokit, config, pr.number);
      allPRDetails[pr.number] = details;
      if (!processedPrNumbers.has(pr.number)) {
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
      process.stdout.write(
        `\rFetching PR details... ${i + 1}/${allPRs.length}`,
      );
    }

    console.log("");

    // Only PRs that pass the developerEmails ownership check are considered "new" for summarization
    const newPRs = enrichedPRs;

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

    // Step D — Ticket ID & Module extraction for PRs
    for (const pr of enrichedPRs) {
      const ticketIds = mergeTicketIds(
        extractTicketIds(pr.title),
        extractTicketIds(pr.body || ""),
        extractJiraTicketLinks(pr.body || ""),
        pr.commits.flatMap((c) => extractTicketIds(c.commit.message)),
      );

      const modules = extractModules(pr.files.map((f) => f.filename));
      const filesChangedCount = pr.files.length;
      const linesAdded = pr.files.reduce((sum, f) => sum + f.additions, 0);
      const linesRemoved = pr.files.reduce((sum, f) => sum + f.deletions, 0);
      const complexitySignal = computeComplexitySignal(filesChangedCount);

      pr.enriched = {
        ticketIds,
        modules,
        filesChangedCount,
        linesAdded,
        linesRemoved,
        complexitySignal,
      };
    }

    // Step E — AI Semantic Grouping of Direct Commits
    // Decide whether to reuse cached commit_group entries or regenerate grouping
    let commitGroups = [];
    let commitGroupsFromCache = false;

    // Gather cached commit groups
    const cachedCommitGroups = cachedItems.filter(
      (i) => i.type === "commit_group",
    );
    // Build a set of SHAs represented by cached groups
    const cachedGroupShas = new Set();
    for (const g of cachedCommitGroups) {
      if (Array.isArray(g.commits)) {
        for (const c of g.commits) {
          if (c && c.sha) cachedGroupShas.add(c.sha);
        }
      }
    }

    // If there are direct commit candidates, check whether cached groups cover them
    if (directCommitCandidates.length > 0) {
      const needRegenerate = directCommitCandidates.some(
        (c) => !cachedGroupShas.has(c.sha),
      );

      if (needRegenerate) {
        console.log(
          "AI grouping direct commits (regenerating because new direct commits found)...",
        );
        try {
          commitGroups = await groupDirectCommits(
            directCommitCandidates,
            selectedProvider,
          );
        } catch (error) {
          console.error(`Failed to group direct commits: ${error.message}`);
          process.exit(1);
        }
      } else if (cachedCommitGroups.length > 0) {
        // Cached groups fully cover current direct commit candidates — reuse them
        commitGroups = cachedCommitGroups;
        commitGroupsFromCache = true;
      } else {
        // No cached groups exist, but we have candidates -> generate
        console.log("AI grouping direct commits...");
        try {
          commitGroups = await groupDirectCommits(
            directCommitCandidates,
            selectedProvider,
          );
        } catch (error) {
          console.error(`Failed to group direct commits: ${error.message}`);
          process.exit(1);
        }
      }
    } else if (cachedCommitGroups.length > 0) {
      // No current direct candidates but cached groups exist — reuse cached groups
      commitGroups = cachedCommitGroups;
      commitGroupsFromCache = true;
    }

    // Step F — AI Summarization loop
    const totalItems =
      newPRs.length + (commitGroupsFromCache ? 0 : commitGroups.length);
    let processedCount = 0;

    for (const pr of enrichedPRs) {
      try {
        const ai_description = await summarizePR(
          pr,
          {
            commits: pr.commits,
            files: pr.files,
            reviewCount: pr.reviewCount,
          },
          selectedProvider,
          developerEmails,
        );

        // Prepare commit messages filtered to developer-authored commits (fallback to all)
        const devEmailsForRecord = Array.isArray(developerEmails)
          ? developerEmails
          : [];
        let recordCommits = pr.commits;
        if (devEmailsForRecord.length > 0) {
          const filtered = pr.commits.filter(
            (c) =>
              !!c.commit?.author?.email &&
              devEmailsForRecord.includes(c.commit.author.email.toLowerCase()),
          );
          if (filtered.length > 0) recordCommits = filtered;
        }

        const record = {
          type: "pr",
          pr_number: pr.number,
          pr_title: pr.title,
          merged_at: pr.merged_at.slice(0, 10),
          commits_count: pr.commits.length,
          files_changed: pr.enriched.filesChangedCount,
          lines_added: pr.enriched.linesAdded,
          lines_removed: pr.enriched.linesRemoved,
          review_iterations: pr.reviewCount,
          modules_touched: pr.enriched.modules,
          commit_messages: recordCommits.map((c) => c.commit.message),
          complexity_signal: pr.enriched.complexitySignal,
          ai_description,
          ticket_ids: pr.enriched.ticketIds,
        };

        await appendToCache(CACHE_PATH, record);
        processedCount++;
        process.stdout.write(
          `\rSummarizing PRs and commit groups... ${processedCount}/${totalItems}`,
        );
      } catch (error) {
        console.warn(
          `\nWarning: Failed to process PR #${pr.number}: ${error.message}`,
        );
        continue;
      }
    }

    if (!commitGroupsFromCache) {
      for (const group of commitGroups) {
        try {
          const ai_description = await summarizeCommitGroup(
            group,
            selectedProvider,
          );

          const record = {
            type: "commit_group",
            date: group.date,
            commits: group.commits,
            files_changed: group.files_changed.length,
            modules_touched: group.modules_touched,
            ai_description,
            ticket_ids: group.ticket_ids || [],
          };

          await appendToCache(CACHE_PATH, record);
          processedCount++;
          process.stdout.write(
            `\rSummarizing PRs and commit groups... ${processedCount}/${totalItems}`,
          );
        } catch (error) {
          console.warn(
            `\nWarning: Failed to process commit group: ${error.message}`,
          );
          continue;
        }
      }
    }

    // Step G — Consolidated cache write & summary
    console.log("");

    const allItems = await readCache(CACHE_PATH);
    await writeConsolidatedCache(CACHE_PATH, allItems);

    const prCount = allItems.filter((i) => i.type === "pr").length;
    const groupCount = allItems.filter((i) => i.type === "commit_group").length;

    if (prCount === 0 && groupCount === 0) {
      console.log("No GitHub data found. Check config.");
    } else {
      console.log(
        `Processed ${prCount} PRs and ${groupCount} commit groups (from ${directCommitCandidates.length} direct commits). Output: cache/github-summary.json`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
})();
