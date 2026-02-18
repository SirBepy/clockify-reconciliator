#!/usr/bin/env node

import fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";

const promptFile = process.argv[2];
const responseFile = process.argv[3];

if (!promptFile || !responseFile) {
  console.error("Usage: gemini-pro.js <promptFile> <responseFile>");
  process.exit(1);
}

async function main() {
  try {
    // Read prompt from file
    if (!fs.existsSync(promptFile)) {
      throw new Error(`Prompt file not found: ${promptFile}`);
    }

    const prompt = fs.readFileSync(promptFile, "utf-8");

    // Initialize Google Generative AI client
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error("GOOGLE_API_KEY environment variable not set");
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

    // Call Gemini Pro
    const result = await model.generateContent(prompt);
    const response = result.response;
    const responseText = response.text();

    // Write response to file
    fs.writeFileSync(responseFile, responseText, "utf-8");

    // Write metadata if token info available
    const metadata = {};
    if (response.usageMetadata) {
      metadata.input_tokens = response.usageMetadata.promptTokenCount;
      metadata.output_tokens = response.usageMetadata.candidatesTokenCount;
    }

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
