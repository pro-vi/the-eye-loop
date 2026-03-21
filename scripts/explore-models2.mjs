import 'dotenv/config';
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

process.env.GOOGLE_GENERATIVE_AI_API_KEY ??= process.env.GEMINI_API_KEY;

// First: list all available models via the REST API
console.log('=== Listing Available Models ===\n');
const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GOOGLE_GENERATIVE_AI_API_KEY}`
);
const data = await res.json();

for (const m of data.models) {
  console.log(`${m.name}  —  ${m.displayName}  [${m.supportedGenerationMethods?.join(', ')}]`);
}

console.log(`\n--- Total: ${data.models.length} models ---\n`);

// Filter for the ones we care about
const interesting = data.models.filter(m =>
  /3\.1|3\.0|nano|banana|veo/i.test(m.displayName) ||
  /gemini-3|nano|banana|veo/i.test(m.name)
);

if (interesting.length) {
  console.log('=== Models matching 3.x / Nano Banana / Veo ===\n');
  for (const m of interesting) {
    console.log(`  ${m.name}`);
    console.log(`    Display: ${m.displayName}`);
    console.log(`    Methods: ${m.supportedGenerationMethods?.join(', ')}`);
    console.log('');
  }
}
