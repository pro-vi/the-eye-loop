# 01 — SvelteKit Scaffold + Deploy Config

## Summary
Initialize SvelteKit project with Svelte 5, Tailwind CSS, Vercel AI SDK 6, and Vercel deploy configuration. This is the foundation everything else builds on.

## Design
Standard SvelteKit init + adapter-vercel + Tailwind + pinned AI SDK deps. vercel.json with fluid:true. maxDuration:300 on server routes. GOOGLE_GENERATIVE_AI_API_KEY in .env.

## Scope
### Files
- svelte.config.js (adapter-vercel, Node.js runtime)
- vercel.json (fluid: true)
- package.json (pinned deps)
- .env.example (GOOGLE_GENERATIVE_AI_API_KEY template)
- tailwind.config.js
- src/app.css (Tailwind imports)
- tsconfig.json (strict: true)

### Subtasks

## Create SvelteKit project
pnpm create svelte@latest with TypeScript, no demo app.

## Install dependencies
pnpm add ai@6.0.134 @ai-sdk/google@3.0.52 @ai-sdk/svelte@4.0.134 zod d3-hierarchy
pnpm add -D @types/d3-hierarchy

## Configure Vercel deploy
vercel.json: { "fluid": true }
svelte.config.js: adapter-vercel with Node.js runtime

## Configure Tailwind
Standard Tailwind 4 setup for SvelteKit.

## Deploy skeleton to Vercel
Push to GitHub, connect to Vercel, verify deploy succeeds with blank page.

### Acceptance criteria
- [ ] `pnpm dev` starts without errors
- [ ] `pnpm build` succeeds
- [ ] TypeScript strict mode enabled, no errors
- [ ] Tailwind utility classes render in browser
- [ ] Deployed to Vercel, accessible via URL
- [ ] vercel.json has `"fluid": true`
- [ ] .env.example lists GOOGLE_GENERATIVE_AI_API_KEY

### Dependencies
None — this is L0, no dependencies.
