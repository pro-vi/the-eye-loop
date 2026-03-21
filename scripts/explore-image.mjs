import 'dotenv/config';
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';
import { writeFileSync } from 'fs';

process.env.GOOGLE_GENERATIVE_AI_API_KEY ??= process.env.GEMINI_API_KEY;

console.log('=== Image Generation Test ===\n');

// Test gemini-2.5-flash-image with responseModalities
console.log('--- gemini-2.5-flash-image (with IMAGE modality) ---');
try {
  const start = Date.now();
  const result = await generateText({
    model: google('gemini-2.5-flash-image'),
    prompt: 'Generate a simple abstract logo: a single eye with concentric circles, minimal, purple and gold on dark background.',
    providerOptions: {
      google: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    maxTokens: 200,
  });
  const elapsed = Date.now() - start;
  console.log(`  Text: ${result.text?.slice(0, 150) || '(none)'}`);
  console.log(`  Files: ${result.files?.length ?? 0}`);
  if (result.files?.length) {
    const f = result.files[0];
    console.log(`  Media type: ${f.mediaType}`);
    console.log(`  Base64 length: ${f.base64?.length ?? 0}`);
    // Save the image
    const buf = Buffer.from(f.base64, 'base64');
    writeFileSync('/tmp/eye-test.png', buf);
    console.log(`  Saved to /tmp/eye-test.png (${buf.length} bytes)`);
  }
  console.log(`  Latency: ${elapsed}ms`);
  console.log(`  Tokens: ${JSON.stringify(result.usage)}`);
} catch (err) {
  console.log(`  ERROR: ${err.message?.slice(0, 300)}`);
}

console.log('');

// Test text-only from flash-image (does it also work as a text model?)
console.log('--- gemini-2.5-flash-image (text only, no IMAGE modality) ---');
try {
  const start = Date.now();
  const result = await generateText({
    model: google('gemini-2.5-flash-image'),
    prompt: 'In 20 words: what colors work for a "taste amplifier" brand?',
    maxTokens: 50,
  });
  console.log(`  Text: ${result.text}`);
  console.log(`  Latency: ${Date.now() - start}ms`);
} catch (err) {
  console.log(`  ERROR: ${err.message?.slice(0, 200)}`);
}

console.log('\n=== Done ===');
