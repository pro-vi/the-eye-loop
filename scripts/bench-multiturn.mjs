import 'dotenv/config';
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';
import { writeFileSync } from 'fs';

process.env.GOOGLE_GENERATIVE_AI_API_KEY ??= process.env.GEMINI_API_KEY;

const renderer = google('gemini-3.1-flash-image-preview');

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  thought_signature / Multi-Turn Reference Image Test   ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// Step 1: Generate base image
console.log('--- Step 1: Generate base image ---');
let baseImage;
try {
  const start = Date.now();
  const result = await generateText({
    model: renderer,
    providerOptions: {
      google: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    prompt: 'Generate a UI card: "Weekly Budget" with a donut chart (60% spent, green/amber), warm cream background, rounded corners.',
  });
  baseImage = result.files?.[0];
  if (baseImage) {
    const buf = Buffer.from(baseImage.base64, 'base64');
    writeFileSync('/tmp/bench-mt-base.png', buf);
    console.log(`  OK: ${baseImage.mediaType} ${buf.length} bytes (${Date.now() - start}ms)`);
  } else {
    console.log('  FAIL: no image returned');
    process.exit(1);
  }
} catch (err) {
  console.log(`  ERROR: ${err.message?.slice(0, 200)}`);
  process.exit(1);
}

// Step 2: Single-turn edit (reference image in messages, no conversation history)
// This is the pattern we plan to use — stateless
console.log('\n--- Step 2: Single-turn edit (stateless, our planned pattern) ---');
try {
  const start = Date.now();
  const result = await generateText({
    model: renderer,
    providerOptions: {
      google: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    messages: [{
      role: 'user',
      content: [
        { type: 'file', data: baseImage.base64, mediaType: baseImage.mediaType },
        { type: 'text', text: 'Change ONLY the donut chart colors from green/amber to purple/pink. Keep everything else exactly the same.' },
      ],
    }],
  });
  if (result.files?.length) {
    const buf = Buffer.from(result.files[0].base64, 'base64');
    writeFileSync('/tmp/bench-mt-edit1.png', buf);
    console.log(`  OK: ${result.files[0].mediaType} ${buf.length} bytes (${Date.now() - start}ms)`);
  } else {
    console.log(`  FAIL: no image (${Date.now() - start}ms)`);
    console.log(`  Text: ${result.text?.slice(0, 200)}`);
  }
} catch (err) {
  console.log(`  ERROR: ${err.message?.slice(0, 200)}`);
}

// Step 3: True multi-turn (2 rounds of conversation history)
// This is what might need thought_signature
console.log('\n--- Step 3: True multi-turn (2 rounds of conversation) ---');
try {
  const start = Date.now();
  const result = await generateText({
    model: renderer,
    providerOptions: {
      google: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    messages: [
      // Turn 1: original prompt
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Generate a UI card: "Weekly Budget" with a donut chart, warm cream background.' },
        ],
      },
      // Turn 1 response: assistant with image
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here is the Weekly Budget card.' },
          { type: 'file', data: baseImage.base64, mediaType: baseImage.mediaType },
        ],
      },
      // Turn 2: edit request
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Now change the donut chart to purple/pink. Keep everything else the same.' },
        ],
      },
    ],
  });
  if (result.files?.length) {
    const buf = Buffer.from(result.files[0].base64, 'base64');
    writeFileSync('/tmp/bench-mt-multiturn.png', buf);
    console.log(`  OK: ${result.files[0].mediaType} ${buf.length} bytes (${Date.now() - start}ms)`);
  } else {
    console.log(`  FAIL: no image (${Date.now() - start}ms)`);
    console.log(`  Text: ${result.text?.slice(0, 200)}`);
  }
} catch (err) {
  console.log(`  ERROR: ${err.message?.slice(0, 300)}`);
  console.log(`  ^ If this mentions thought_signature, AI SDK doesn't handle it automatically`);
}

// Step 4: Chained stateless edits (edit1 → edit2, no history)
// Tests drift over 2 edits
console.log('\n--- Step 4: Chained stateless edits (2 sequential, no history) ---');
try {
  // Edit 1
  const start = Date.now();
  const edit1 = await generateText({
    model: renderer,
    providerOptions: {
      google: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    messages: [{
      role: 'user',
      content: [
        { type: 'file', data: baseImage.base64, mediaType: baseImage.mediaType },
        { type: 'text', text: 'Change ONLY the background from cream to dark charcoal (#1a1a2e). Keep all other elements the same.' },
      ],
    }],
  });

  if (!edit1.files?.length) {
    console.log('  FAIL: edit1 no image');
  } else {
    const buf1 = Buffer.from(edit1.files[0].base64, 'base64');
    writeFileSync('/tmp/bench-mt-chain1.png', buf1);
    console.log(`  Edit 1 (bg→dark): OK ${buf1.length} bytes (${Date.now() - start}ms)`);

    // Edit 2: take edit1's output, change another axis
    const start2 = Date.now();
    const edit2 = await generateText({
      model: renderer,
      providerOptions: {
        google: { responseModalities: ['TEXT', 'IMAGE'] },
      },
      messages: [{
        role: 'user',
        content: [
          { type: 'file', data: edit1.files[0].base64, mediaType: edit1.files[0].mediaType },
          { type: 'text', text: 'Change ONLY the typography to a bold geometric sans-serif. Keep the dark background and donut chart exactly as they are.' },
        ],
      }],
    });

    if (edit2.files?.length) {
      const buf2 = Buffer.from(edit2.files[0].base64, 'base64');
      writeFileSync('/tmp/bench-mt-chain2.png', buf2);
      console.log(`  Edit 2 (typo→geo): OK ${buf2.length} bytes (${Date.now() - start2}ms)`);
      console.log(`  Total chain: ${Date.now() - start}ms`);
    } else {
      console.log(`  FAIL: edit2 no image`);
    }
  }
} catch (err) {
  console.log(`  ERROR: ${err.message?.slice(0, 200)}`);
}

console.log('\n  Compare: /tmp/bench-mt-{base,edit1,multiturn,chain1,chain2}.png');
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  DONE');
console.log('═══════════════════════════════════════════════════════════\n');
