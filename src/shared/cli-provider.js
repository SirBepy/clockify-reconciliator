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

  try {
    const result = spawnSync(
      "node",
      [providerScript, promptFile, responseFile],
      {
        encoding: "utf-8",
        stdio: ["inherit", "pipe", "pipe"],
      },
    );

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(
        `Provider execution failed with status ${result.status}: ${result.stderr || result.stdout}`,
      );
    }
  } catch (error) {
    throw new Error(`Provider execution failed: ${error.message}`);
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
