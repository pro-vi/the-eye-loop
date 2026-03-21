import 'dotenv/config';
import { google } from '@ai-sdk/google';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { writeFileSync } from 'fs';

process.env.GOOGLE_GENERATIVE_AI_API_KEY ??= process.env.GEMINI_API_KEY;

const renderer = google('gemini-3.1-flash-image-preview');
const generator = google('gemini-3.1-flash-lite-preview');

// ═══════════════════════════════════════════════════════════════════════
//  TEST 1: Structured Output + Image Gen Combo
//  Can Output.object() coexist with responseModalities: ['TEXT','IMAGE']?
// ═══════════════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  TEST 1: Structured Output + Image Gen Combo           ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

const facadeSchema = z.object({
  hypothesis_tested: z.string(),
  accept_implies: z.string(),
  reject_implies: z.string(),
  dimension: z.string(),
  held_constant: z.array(z.string()),
});

// Test A: Output.object() + responseModalities together
console.log('--- A: Output.object() + IMAGE modality (single call) ---');
try {
  const start = Date.now();
  const result = await generateText({
    model: renderer,
    output: Output.object({ schema: facadeSchema }),
    providerOptions: {
      google: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    prompt: `Generate a moodboard image for a warm-organic personal finance app.
Also output structured metadata about what this facade tests.
The hypothesis: sunset-warm palette vs forest-muted palette.
Dimension being tested: palette.
Held constant: tone (warm-organic), density (sparse).`,
  });
  const elapsed = Date.now() - start;
  console.log(`  Output object: ${JSON.stringify(result.output, null, 2)}`);
  console.log(`  Files: ${result.files?.length ?? 0}`);
  if (result.files?.length) {
    const f = result.files[0];
    const buf = Buffer.from(f.base64, 'base64');
    writeFileSync('/tmp/bench-combo-a.png', buf);
    console.log(`  Image: ${f.mediaType} ${buf.length} bytes → /tmp/bench-combo-a.png`);
  }
  console.log(`  ${elapsed}ms`);
  console.log(`  VERDICT: ${result.output && result.files?.length ? 'BOTH WORK' : result.output ? 'TEXT ONLY' : result.files?.length ? 'IMAGE ONLY' : 'NEITHER'}`);
} catch (err) {
  console.log(`  ERROR: ${err.message?.slice(0, 300)}`);
  console.log(`  VERDICT: INCOMPATIBLE — need two calls`);
}

// Test B: No Output.object(), parse metadata from text manually
console.log('\n--- B: No Output.object(), IMAGE modality + text parse ---');
try {
  const start = Date.now();
  const result = await generateText({
    model: renderer,
    providerOptions: {
      google: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    prompt: `Generate a moodboard image for a warm-organic personal finance app.

After the image, output ONLY this JSON (no markdown, no explanation):
{"hypothesis_tested":"sunset-warm vs forest-muted","accept_implies":"sunset-warm confirmed","reject_implies":"forest-muted gains probability","dimension":"palette","held_constant":["tone:warm-organic","density:sparse"]}`,
  });
  const elapsed = Date.now() - start;
  console.log(`  Text: ${result.text?.slice(0, 200)}`);
  console.log(`  Files: ${result.files?.length ?? 0}`);
  if (result.files?.length) {
    const buf = Buffer.from(result.files[0].base64, 'base64');
    writeFileSync('/tmp/bench-combo-b.png', buf);
    console.log(`  Image: ${result.files[0].mediaType} ${buf.length} bytes`);
  }
  // Try to parse JSON from text
  const jsonMatch = result.text?.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`  Parsed metadata: ${JSON.stringify(parsed)}`);
      console.log(`  VERDICT: WORKS — text parsing viable`);
    } catch {
      console.log(`  VERDICT: IMAGE OK, JSON parse failed`);
    }
  } else {
    console.log(`  VERDICT: IMAGE OK, no JSON in text`);
  }
  console.log(`  ${elapsed}ms`);
} catch (err) {
  console.log(`  ERROR: ${err.message?.slice(0, 200)}`);
}

// Test C: Two separate calls (Generator for metadata, Renderer for image)
console.log('\n--- C: Two calls — Generator metadata + Renderer image (parallel) ---');
try {
  const start = Date.now();
  const [metaResult, imgResult] = await Promise.all([
    generateText({
      model: generator,
      output: Output.object({ schema: facadeSchema }),
      prompt: `You are a Scout generating facade metadata.
Hypothesis: sunset-warm palette vs forest-muted for a warm-organic personal finance app.
Output the structured metadata for this facade probe.`,
    }),
    generateText({
      model: renderer,
      providerOptions: {
        google: { responseModalities: ['TEXT', 'IMAGE'] },
      },
      prompt: `Generate a moodboard image for a personal finance app.
Style: warm-organic, sparse, rounded shapes.
Palette: sunset-warm — amber gradients, soft peach, cream.
Must NOT include: corporate blue, dense grids, sharp rectangles.`,
    }),
  ]);
  const elapsed = Date.now() - start;
  console.log(`  Metadata: ${JSON.stringify(metaResult.output)}`);
  console.log(`  Files: ${imgResult.files?.length ?? 0}`);
  if (imgResult.files?.length) {
    const buf = Buffer.from(imgResult.files[0].base64, 'base64');
    writeFileSync('/tmp/bench-combo-c.png', buf);
    console.log(`  Image: ${imgResult.files[0].mediaType} ${buf.length} bytes`);
  }
  console.log(`  ${elapsed}ms (parallel — wall time of slower call)`);
  console.log(`  VERDICT: WORKS — parallel two-call pattern`);
} catch (err) {
  console.log(`  ERROR: ${err.message?.slice(0, 200)}`);
}

// ═══════════════════════════════════════════════════════════════════════
//  TEST 2: Reference Image Editing (One-Axis Sweep)
//  Does NB2 respect "change only X, keep everything else"?
// ═══════════════════════════════════════════════════════════════════════

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║  TEST 2: Reference Image Editing (One-Axis Sweep)      ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// First generate a base image
console.log('--- Generating base image ---');
let baseImage;
try {
  const result = await generateText({
    model: renderer,
    providerOptions: {
      google: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    prompt: `Generate a clean UI card for a personal finance app.
Style: warm-organic, rounded corners, amber gradient header.
Content: "Monthly Savings" with a simple bar chart, 3 bars.
Background: cream. No text below the card. Square format.`,
  });
  if (result.files?.length) {
    baseImage = result.files[0];
    const buf = Buffer.from(baseImage.base64, 'base64');
    writeFileSync('/tmp/bench-sweep-base.png', buf);
    console.log(`  Base image: ${baseImage.mediaType} ${buf.length} bytes → /tmp/bench-sweep-base.png`);
  }
} catch (err) {
  console.log(`  ERROR generating base: ${err.message?.slice(0, 200)}`);
}

if (baseImage) {
  const sweeps = [
    { axis: 'palette', instruction: 'Change ONLY the color palette from warm amber to cool ocean blue. Keep the layout, content, typography, and composition exactly the same.' },
    { axis: 'shape', instruction: 'Change ONLY the corner radius from rounded to sharp/rectangular. Keep the colors, content, typography, and composition exactly the same.' },
    { axis: 'density', instruction: 'Change ONLY the density — make it more packed with data (add 2 more chart bars, add subtitle text, reduce whitespace). Keep colors and style exactly the same.' },
  ];

  for (const sweep of sweeps) {
    console.log(`\n--- Sweep: ${sweep.axis} ---`);
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
            // Reference image FIRST
            { type: 'file', data: baseImage.base64, mediaType: baseImage.mediaType },
            // Variation instruction LAST
            { type: 'text', text: sweep.instruction },
          ],
        }],
      });
      const elapsed = Date.now() - start;
      if (result.files?.length) {
        const buf = Buffer.from(result.files[0].base64, 'base64');
        writeFileSync(`/tmp/bench-sweep-${sweep.axis}.png`, buf);
        console.log(`  ${result.files[0].mediaType} ${buf.length} bytes → /tmp/bench-sweep-${sweep.axis}.png`);
        console.log(`  Text: ${result.text?.slice(0, 100) || '(none)'}`);
      } else {
        console.log(`  No image returned`);
        console.log(`  Text: ${result.text?.slice(0, 200)}`);
      }
      console.log(`  ${elapsed}ms`);
    } catch (err) {
      console.log(`  ERROR: ${err.message?.slice(0, 200)}`);
    }
  }
  console.log('\n  Compare visually: /tmp/bench-sweep-{base,palette,shape,density}.png');
} else {
  console.log('  SKIPPED — no base image generated');
}

// ═══════════════════════════════════════════════════════════════════════
//  TEST 3: Google Search Grounding
//  Does grounding improve mockup quality? What's the latency cost?
// ═══════════════════════════════════════════════════════════════════════

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║  TEST 3: Google Search Grounding                       ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

const mockupPrompt = `Generate a mobile app mockup image for a personal finance dashboard.
Style: warm-organic, modern fintech aesthetic like Revolut or Monzo but warmer.
Include: balance card, recent transactions list, spending chart.
Palette: amber, peach, cream. Rounded corners. No corporate blue.`;

// Without grounding
console.log('--- A: Without Search Grounding ---');
try {
  const start = Date.now();
  const result = await generateText({
    model: renderer,
    providerOptions: {
      google: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    prompt: mockupPrompt,
  });
  const elapsed = Date.now() - start;
  if (result.files?.length) {
    const buf = Buffer.from(result.files[0].base64, 'base64');
    writeFileSync('/tmp/bench-ground-none.png', buf);
    console.log(`  ${buf.length} bytes → /tmp/bench-ground-none.png`);
  }
  console.log(`  ${elapsed}ms | ${result.usage?.totalTokens} tok`);
} catch (err) {
  console.log(`  ERROR: ${err.message?.slice(0, 200)}`);
}

// With grounding
console.log('\n--- B: With Search Grounding ---');
try {
  const start = Date.now();
  const result = await generateText({
    model: renderer,
    providerOptions: {
      google: {
        responseModalities: ['TEXT', 'IMAGE'],
        tools: [{ googleSearch: {} }],
      },
    },
    prompt: mockupPrompt,
  });
  const elapsed = Date.now() - start;
  if (result.files?.length) {
    const buf = Buffer.from(result.files[0].base64, 'base64');
    writeFileSync('/tmp/bench-ground-search.png', buf);
    console.log(`  ${buf.length} bytes → /tmp/bench-ground-search.png`);
  }
  console.log(`  Text: ${result.text?.slice(0, 150) || '(none)'}`);
  console.log(`  ${elapsed}ms | ${result.usage?.totalTokens} tok`);
} catch (err) {
  console.log(`  ERROR: ${err.message?.slice(0, 200)}`);
}

// Also test grounding with Flash Lite for HTML mockups
console.log('\n--- C: Flash Lite HTML mockup WITH Search Grounding ---');
try {
  const start = Date.now();
  const result = await generateText({
    model: generator,
    providerOptions: {
      google: {
        tools: [{ googleSearch: {} }],
      },
    },
    prompt: `Generate a complete HTML+CSS mobile mockup (375x667, inline styles, no scripts) for a personal finance dashboard.
Style: warm-organic like Revolut/Monzo but warmer. Amber, peach, cream palette.
Include: balance card with gradient, recent transactions, spending mini-chart.
No corporate blue. Rounded corners. No sharp rectangles.`,
    maxTokens: 2000,
  });
  const elapsed = Date.now() - start;
  const hasHtml = /<html|<div|<!DOCTYPE/i.test(result.text);
  console.log(`  HTML output: ${hasHtml ? 'YES' : 'NO'} (${result.text?.length} chars)`);
  console.log(`  ${elapsed}ms | ${result.usage?.totalTokens} tok`);
  if (hasHtml) {
    // Extract HTML
    const htmlMatch = result.text.match(/```html?\n?([\s\S]*?)```/) || [null, result.text];
    writeFileSync('/tmp/bench-ground-html.html', htmlMatch[1] || result.text);
    console.log(`  Saved → /tmp/bench-ground-html.html`);
  }
} catch (err) {
  console.log(`  ERROR: ${err.message?.slice(0, 200)}`);
}

console.log('\n--- D: Flash Lite HTML mockup WITHOUT Search Grounding ---');
try {
  const start = Date.now();
  const result = await generateText({
    model: generator,
    prompt: `Generate a complete HTML+CSS mobile mockup (375x667, inline styles, no scripts) for a personal finance dashboard.
Style: warm-organic like Revolut/Monzo but warmer. Amber, peach, cream palette.
Include: balance card with gradient, recent transactions, spending mini-chart.
No corporate blue. Rounded corners. No sharp rectangles.`,
    maxTokens: 2000,
  });
  const elapsed = Date.now() - start;
  const hasHtml = /<html|<div|<!DOCTYPE/i.test(result.text);
  console.log(`  HTML output: ${hasHtml ? 'YES' : 'NO'} (${result.text?.length} chars)`);
  console.log(`  ${elapsed}ms | ${result.usage?.totalTokens} tok`);
  if (hasHtml) {
    const htmlMatch = result.text.match(/```html?\n?([\s\S]*?)```/) || [null, result.text];
    writeFileSync('/tmp/bench-noground-html.html', htmlMatch[1] || result.text);
    console.log(`  Saved → /tmp/bench-noground-html.html`);
  }
} catch (err) {
  console.log(`  ERROR: ${err.message?.slice(0, 200)}`);
}

console.log('\n  Compare: /tmp/bench-ground-{none,search}.png and /tmp/bench-{ground,noground}-html.html');

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  DONE — check /tmp/bench-* files for visual comparison');
console.log('═══════════════════════════════════════════════════════════\n');
