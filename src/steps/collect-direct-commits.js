#!/usr/bin/env node

// ============================================================================
// Section 1 — Imports & constants
// ============================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { Octokit } from "@octokit/rest";
import { loadConfig } from "../shared/config.js";
import {
  initCache,
  appendToCache,
  clearCache,
  writeConsolidatedCache,
  readCache,
} from "../shared/cache.js";
import { extractModules } from "../shared/module-extractor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

const CACHE_PATH = path.resolve(projectRoot, "cache", "direct-commits.ndjson");

// ============================================================================
// Section 2 — CLI argument parsing
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
collect-direct-commits — Fetch commits authored by the developer from GitHub

Usage:
  node collect-direct-commits.js [options]

Options:
  --force-refresh, -f     Clear cache and start fresh
  --help, -h              Show this help message
`);
  process.exit(0);
}

// ============================================================================
// Section 3 — Main async IIFE
// ============================================================================

(async () => {
  // =========================================================================
  // 3a. Config loading & GitHub credential validation
  // =========================================================================

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

  // =========================================================================
  // 3b. Developer identity resolution
  // =========================================================================

  let developerEmails = [];

  if (
    Array.isArray(config.github.developer_emails) &&
    config.github.developer_emails.length > 0
  ) {
    developerEmails = config.github.developer_emails;
  } else {
    try {
      let primaryEmail = null;

      try {
        const emailsResponse =
          await octokit.users.listEmailsForAuthenticatedUser();
        const primaryEntry = emailsResponse.data.find((e) => e.primary);
        if (primaryEntry) {
          primaryEmail = primaryEntry.email;
        }
      } catch (emailError) {
        // Fall back to getAuthenticated
      }

      if (!primaryEmail) {
        const authUserResponse = await octokit.users.getAuthenticated();
        primaryEmail = authUserResponse.data.email;
      }

      if (!primaryEmail) {
        console.error(
          "Failed to fetch developer email from GitHub API: Unable to determine primary email",
        );
        process.exit(1);
      }

      developerEmails = [primaryEmail];
    } catch (error) {
      console.error(
        `Failed to fetch developer email from GitHub API: ${error.message}`,
      );
      process.exit(1);
    }
  }

  const developerEmailsNormalized = new Set(
    developerEmails.map((e) => e.toLowerCase()),
  );
  console.log(
    `Filtering commits by: ${Array.from(developerEmailsNormalized).join(", ")}`,
  );

  // =========================================================================
  // 3c. Force-refresh handling
  // =========================================================================

  if (parsedArgs.values["force-refresh"]) {
    clearCache(CACHE_PATH);
    console.log("Cache cleared.");
  }

  // =========================================================================
  // 3d. Cache initialisation (resume detection)
  // =========================================================================

  const existingItems = await initCache(CACHE_PATH);
  const processedShas = new Set(existingItems.map((item) => item.sha));

  // =========================================================================
  // 3e. Commit fetching with pagination
  // =========================================================================

  let allCommits = [];
  let page = 0;

  try {
    const commitsIterator = await octokit.paginate(
      octokit.repos.listCommits,
      {
        owner: config.github.repo_owner,
        repo: config.github.repo_name,
        sha: config.github.main_branch,
        since: config.github.date_from + "T00:00:00Z",
        until: config.github.date_to + "T23:59:59Z",
        per_page: 100,
      },
      (response, done) => {
        allCommits = allCommits.concat(response.data);
        page++;
        process.stdout.write(`\rFetching commits... ${page}`);
        return response.data;
      },
    );
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

  console.log(`\nTotal commits fetched: ${allCommits.length}`);

  // =========================================================================
  // 3f. Commit filtering by email
  // =========================================================================

  const filteredCommits = allCommits.filter((commit) => {
    const email = commit.commit?.author?.email;
    return email ? developerEmailsNormalized.has(email.toLowerCase()) : false;
  });

  console.log(
    `Filtering direct commits... ${filteredCommits.length}/${allCommits.length}`,
  );

  if (filteredCommits.length === 0) {
    console.log("No commits found for developer in date range. Check config.");
    process.exit(0);
  }

  // =========================================================================
  // 3g. Detail fetching + module extraction + cache appending
  // =========================================================================

  const filteredTotal = filteredCommits.length;
  let processedCount = 0;

  for (const commit of filteredCommits) {
    if (processedShas.has(commit.sha)) {
      continue;
    }

    let detail;
    try {
      const detailResponse = await octokit.repos.getCommit({
        owner: config.github.repo_owner,
        repo: config.github.repo_name,
        ref: commit.sha,
      });
      detail = detailResponse.data;
    } catch (error) {
      console.error(
        `\nFailed to fetch commit details for ${commit.sha}: ${error.message}`,
      );
      process.exit(1);
    }

    const record = {
      sha: commit.sha,
      date: commit.commit.author.date,
      message: commit.commit.message,
      files_changed: detail.files.map((f) => f.filename),
      lines_added: detail.stats.additions,
      lines_removed: detail.stats.deletions,
      modules_touched: extractModules(detail.files.map((f) => f.filename)),
    };

    await appendToCache(CACHE_PATH, record);
    processedCount++;
    process.stdout.write(
      `\rProcessing commits... ${processedCount}/${filteredTotal}`,
    );
  }

  console.log("");

  // =========================================================================
  // 3h. Consolidated JSON write & summary
  // =========================================================================

  const allItems = await readCache(CACHE_PATH);
  await writeConsolidatedCache(CACHE_PATH, allItems);

  if (allItems.length === 0) {
    console.log("No commits found for developer in date range. Check config.");
  } else {
    console.log(
      `Collected ${allItems.length} developer commits from main branch. Output: cache/direct-commits.json`,
    );
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
