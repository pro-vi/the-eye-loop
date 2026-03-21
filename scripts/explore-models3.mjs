import 'dotenv/config';
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';
import { writeFileSync } from 'fs';

process.env.GOOGLE_GENERATIVE_AI_API_KEY ??= process.env.GEMINI_API_KEY;

const prompt = 'Reply in exactly 10 words: describe what a "taste amplifier" app would do.';

const models = [
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (orchestrator/builder)' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (scout text alternative)' },
  { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite (cheap scout)' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (baseline scout)' },
];

console.log('=== Text Models ===\n');

for (const m of models) {
  try {
    console.log(`--- ${m.label} ---`);
    const start = Date.now();
    const result = await generateText({
      model: google(m.id),
      prompt,
      maxTokens: 50,
    });
    const elapsed = Date.now() - start;
    console.log(`  "${result.text}"`);
    console.log(`  ${elapsed}ms | tokens: ${result.usage?.totalTokens}`);
  } catch (err) {
    console.log(`  ERROR: ${err.message?.slice(0, 150)}`);
  }
  console.log('');
}

console.log('=== Image Models ===\n');

const imageModels = [
  { id: 'gemini-2.5-flash-image', label: 'Nano Banana (original)' },
  { id: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro (Gemini 3 Pro Image)' },
  { id: 'gemini-3.1-flash-image-preview', label: 'Nano Banana 2 (Gemini 3.1 Flash Image)' },
];

const imgPrompt = 'Generate a small moodboard image: dark theme, purple accents, minimalist UI aesthetic. 256x256.';

for (const m of imageModels) {
  try {
    console.log(`--- ${m.label} ---`);
    const start = Date.now();
    const result = await generateText({
      model: google(m.id),
      prompt: imgPrompt,
      providerOptions: {
        google: { responseModalities: ['TEXT', 'IMAGE'] },
      },
      maxTokens: 200,
    });
    const elapsed = Date.now() - start;
    console.log(`  Text: ${result.text?.slice(0, 80) || '(none)'}`);
    console.log(`  Files: ${result.files?.length ?? 0}`);
    if (result.files?.length) {
      const f = result.files[0];
      const buf = Buffer.from(f.base64, 'base64');
      const path = `/tmp/eye-${m.id}.png`;
      writeFileSync(path, buf);
      console.log(`  ${f.mediaType} | ${buf.length} bytes | saved ${path}`);
    }
    console.log(`  ${elapsed}ms | tokens: ${result.usage?.totalTokens}`);
  } catch (err) {
    console.log(`  ERROR: ${err.message?.slice(0, 200)}`);
  }
  console.log('');
}
