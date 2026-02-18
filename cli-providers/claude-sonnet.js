#!/usr/bin/env node

import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";

const promptFile = process.argv[2];
const responseFile = process.argv[3];

if (!promptFile || !responseFile) {
  console.error("Usage: claude-sonnet.js <promptFile> <responseFile>");
  process.exit(1);
}

async function main() {
  try {
    // Read prompt from file
    if (!fs.existsSync(promptFile)) {
      throw new Error(`Prompt file not found: ${promptFile}`);
    }

    const prompt = fs.readFileSync(promptFile, "utf-8");

    // Initialize Anthropic client
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable not set");
    }

    const client = new Anthropic({ apiKey });

    // Call Claude Sonnet
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16384,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    // Extract text response
    const responseText =
      message.content[0].type === "text" ? message.content[0].text : "";

    // Write response to file
    fs.writeFileSync(responseFile, responseText, "utf-8");

    // Write metadata
    const metadata = {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      model: message.model,
      stop_reason: message.stop_reason,
    };

    fs.writeFileSync(
      responseFile + ".meta.json",
      JSON.stringify(metadata, null, 2),
      "utf-8",
    );
  } catch (error) {
    // Write error to response file
    fs.writeFileSync(responseFile, `Error: ${error.message}`, "utf-8");
    process.exit(1);
  }
}

main();
