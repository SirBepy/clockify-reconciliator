import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import readline from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, "../../");

/**
 * List available providers from cli-providers/ directory
 * @returns {string[]} Array of provider names (without extension)
 */
export function listProviders() {
  const providersDir = path.join(projectRoot, "cli-providers");

  if (!fs.existsSync(providersDir)) {
    return [];
  }

  const files = fs.readdirSync(providersDir);
  return files
    .filter((file) => file.endsWith(".js"))
    .map((file) => file.replace(".js", ""));
}

/**
 * Interactive provider selection
 * @param {string[]} providers - Array of available providers
 * @returns {Promise<string>} Selected provider name
 */
export async function promptProviderSelection(providers) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("No providers available");
  }

  const menu = providers
    .map((provider, index) => `${index + 1}) ${provider}`)
    .join(" ");

  console.log(`Select AI provider: ${menu}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const ask = () => {
      rl.question("Enter selection (number): ", (answer) => {
        const index = parseInt(answer, 10) - 1;
        if (isNaN(index) || index < 0 || index >= providers.length) {
          console.log(
            `Invalid selection. Please enter a number between 1 and ${providers.length}.`,
          );
          ask();
          return;
        }

        rl.close();
        resolve(providers[index]);
      });
    };

    ask();
  });
}

/**
 * Execute provider with file-based contract
 * @param {string} providerName - Name of provider to execute
 * @param {string} prompt - Prompt text to send to provider
 * @returns {Promise<{response: string, metadata: object}>} Provider response and metadata
 * @throws {Error} If provider execution fails
 */
export async function executeProvider(providerName, prompt) {
  const providers = listProviders();
  if (!providers.includes(providerName)) {
    throw new Error(`Provider '${providerName}' not found in cli-providers/`);
  }

  // Generate UUID for this prompt
  const uuid = randomUUID();
  const promptsDir = path.join(projectRoot, "cache/prompts");

  // Create prompts directory if needed
  if (!fs.existsSync(promptsDir)) {
    fs.mkdirSync(promptsDir, { recursive: true });
  }

  // Write prompt to file
  const promptFile = path.join(promptsDir, `prompt-${uuid}.txt`);
  const responseFile = path.join(promptsDir, `response-${uuid}.txt`);

  try {
    fs.writeFileSync(promptFile, prompt, "utf-8");
  } catch (error) {
    throw new Error(`Failed to write prompt file: ${error.message}`);
  }

  // Execute provider script
  const providerScript = path.join(
    projectRoot,
    `cli-providers/${providerName}.js`,
  );

  // Inject API keys from config.json into the child process env (env var takes precedence if already set)
  const childEnv = { ...process.env };
  try {
    const configPath = path.join(projectRoot, "config.json");
    const configContent = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(configContent);
    if (config.ai?.anthropic_api_key && !childEnv.ANTHROPIC_API_KEY) {
      childEnv.ANTHROPIC_API_KEY = config.ai.anthropic_api_key;
    }
    if (config.ai?.gemini_api_key && !childEnv.GOOGLE_API_KEY) {
      childEnv.GOOGLE_API_KEY = config.ai.gemini_api_key;
    }
  } catch {
    // Config read failure is non-fatal; provider will surface missing key error
  }

  const MAX_RETRIES = 3;
  const RETRY_DELAYS_MS = [5000, 15000, 30000];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 30000;
      process.stdout.write(
        `\nAPI overloaded, retrying in ${delay / 1000}s (attempt ${attempt}/${MAX_RETRIES})...\n`,
      );
      await sleep(delay);
      if (fs.existsSync(responseFile)) fs.unlinkSync(responseFile);
    }

    const result = spawnSync(
      "node",
      [providerScript, promptFile, responseFile],
      {
        encoding: "utf-8",
        stdio: ["inherit", "pipe", "pipe"],
        env: childEnv,
      },
    );

    if (result.error) {
      throw new Error(`Provider execution failed: ${result.error.message}`);
    }

    if (result.status === 0) break;

    let detail = result.stderr || result.stdout || "";
    if (!detail && fs.existsSync(responseFile)) {
      detail = fs.readFileSync(responseFile, "utf-8");
    }

    lastError = `Provider execution failed with status ${result.status}: ${detail}`;

    const isOverloaded =
      detail.includes("overloaded") || detail.includes("529");
    if (!isOverloaded || attempt === MAX_RETRIES) {
      throw new Error(`Provider execution failed: ${lastError}`);
    }
  }

  // Read response file
  if (!fs.existsSync(responseFile)) {
    throw new Error("Provider did not write response file");
  }

  let response;
  let metadata = {};

  try {
    response = fs.readFileSync(responseFile, "utf-8");
  } catch (error) {
    throw new Error(`Failed to read response file: ${error.message}`);
  }

  // Read metadata file if it exists
  const metaFile = responseFile + ".meta.json";
  if (fs.existsSync(metaFile)) {
    try {
      const metaContent = fs.readFileSync(metaFile, "utf-8");
      metadata = JSON.parse(metaContent);
    } catch (error) {
      console.warn(`Warning: Failed to read metadata file: ${error.message}`);
    }
  }

  return { response, metadata };
}
