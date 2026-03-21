import 'dotenv/config';
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';

// AI SDK expects GOOGLE_GENERATIVE_AI_API_KEY
process.env.GOOGLE_GENERATIVE_AI_API_KEY ??= process.env.GEMINI_API_KEY;

const models = [
  { id: 'gemini-2.5-flash', label: 'Flash 2.5 (scout text/HTML)' },
  { id: 'gemini-2.5-flash-preview-native-audio-dialog', label: 'Flash 2.5 Audio (skip if unavail)' },
  { id: 'gemini-2.5-pro', label: 'Pro 2.5 (orchestrator fallback)' },
  // Spec says Gemini 3.1 Pro — let's test what's actually available
  { id: 'gemini-2.5-pro-preview-06-05', label: 'Pro 2.5 preview' },
];

const prompt = 'Reply in exactly 10 words: describe what a "taste amplifier" app would do.';

console.log('=== Model Exploration ===\n');
console.log(`API key: ${process.env.GOOGLE_GENERATIVE_AI_API_KEY?.slice(0, 10)}...`);
console.log('');

for (const m of models) {
  try {
    console.log(`--- ${m.label} (${m.id}) ---`);
    const start = Date.now();
    const result = await generateText({
      model: google(m.id),
      prompt,
      maxTokens: 50,
    });
    const elapsed = Date.now() - start;
    console.log(`  Response: ${result.text}`);
    console.log(`  Latency: ${elapsed}ms`);
    console.log(`  Tokens: ${result.usage?.totalTokens ?? 'n/a'}`);
    console.log('');
  } catch (err) {
    console.log(`  ERROR: ${err.message?.slice(0, 120)}`);
    console.log('');
  }
}

// Test image generation via generateText (Nano Banana pattern)
console.log('--- Image Gen: Flash Image via generateText ---');
try {
  const start = Date.now();
  const result = await generateText({
    model: google('gemini-2.0-flash-exp'),
    prompt: 'Generate a simple abstract logo: a single eye with concentric circles, minimal, purple and gold.',
    providerOptions: {
      google: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    maxTokens: 200,
  });
  const elapsed = Date.now() - start;
  console.log(`  Text: ${result.text?.slice(0, 100) || '(none)'}`);
  console.log(`  Files: ${result.files?.length ?? 0}`);
  if (result.files?.length) {
    const f = result.files[0];
    console.log(`  First file: ${f.mediaType}, ${f.base64?.length ?? 0} base64 chars`);
  }
  console.log(`  Latency: ${elapsed}ms`);
} catch (err) {
  console.log(`  ERROR: ${err.message?.slice(0, 200)}`);
}
console.log('');

// Also try the actual model names from spec
console.log('--- Checking spec model names ---');
const specModels = ['gemini-3.1-pro', 'gemini-2.5-flash-image'];
for (const id of specModels) {
  try {
    const result = await generateText({
      model: google(id),
      prompt: 'Say hello.',
      maxTokens: 10,
    });
    console.log(`  ${id}: OK — "${result.text}"`);
  } catch (err) {
    console.log(`  ${id}: NOT AVAILABLE — ${err.message?.slice(0, 100)}`);
  }
}

console.log('\n=== Done ===');
