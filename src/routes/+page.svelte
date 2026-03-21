<script lang="ts">
	import type {
		Facade,
		SwipeEvidence,
		TasteSynthesis,
		AgentState,
		PrototypeDraft,
		Stage
	} from '$lib/context/types';
	import SwipeFeed from '$lib/components/SwipeFeed.svelte';
	import AnimaPanel from '$lib/components/AnimaPanel.svelte';
	import AgentStatus from '$lib/components/AgentStatus.svelte';
	import PrototypeDraftPanel from '$lib/components/PrototypeDraft.svelte';

	// ── State machine ────────────────────────────────────────────────
	let mode = $state<'intent' | 'swiping' | 'reveal'>('intent');
	let intentText = $state('');
	let loading = $state(false);
	let error = $state('');
	let sessionId = $state<string | null>(null);

	// ── SSE-driven state ─────────────────────────────────────────────
	let facades = $state<Facade[]>([]);
	let evidence = $state<SwipeEvidence[]>([]);
	let synthesis = $state<TasteSynthesis | null>(null);
	let antiPatterns = $state<string[]>([]);
	let agents = $state<AgentState[]>([]);
	let draft = $state<PrototypeDraft>({
		title: '',
		summary: '',
		html: '',
		acceptedPatterns: [],
		rejectedPatterns: []
	});
	let stage = $state<Stage>('words');

	// ── Session creation ─────────────────────────────────────────────
	async function startSession() {
		if (!intentText.trim() || loading) return;
		loading = true;
		error = '';

		try {
			const res = await fetch('/api/session', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ intent: intentText.trim() })
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `Session failed (${res.status})`);
			}

			const data = await res.json();
			sessionId = data.sessionId;
			mode = 'swiping';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to start session';
		} finally {
			loading = false;
		}
	}

	// ── SSE connection ───────────────────────────────────────────────
	$effect(() => {
		if (mode !== 'swiping') return;

		const es = new EventSource('/api/stream');

		es.addEventListener('facade-ready', (e) => {
			const { facade } = JSON.parse(e.data);
			facades = [...facades, facade];
		});

		es.addEventListener('facade-stale', (e) => {
			const { facadeId } = JSON.parse(e.data);
			facades = facades.filter((f) => f.id !== facadeId);
		});

		es.addEventListener('evidence-updated', (e) => {
			const data = JSON.parse(e.data);
			evidence = data.evidence;
			antiPatterns = data.antiPatterns;
		});

		es.addEventListener('synthesis-updated', (e) => {
			const { synthesis: s } = JSON.parse(e.data);
			synthesis = s;
		});

		es.addEventListener('agent-status', (e) => {
			const { agent } = JSON.parse(e.data);
			agents = agents.some((a) => a.id === agent.id)
				? agents.map((a) => (a.id === agent.id ? agent : a))
				: [...agents, agent];
		});

		es.addEventListener('draft-updated', (e) => {
			const { draft: d } = JSON.parse(e.data);
			draft = d;
		});

		es.addEventListener('builder-hint', (e) => {
			const { hint } = JSON.parse(e.data);
			draft = { ...draft, nextHint: hint };
		});

		es.addEventListener('stage-changed', (e) => {
			const data = JSON.parse(e.data);
			stage = data.stage;
			if (data.stage === 'reveal') mode = 'reveal';
		});

		es.onerror = () => {
			console.error('[sse] connection error');
		};

		return () => es.close();
	});

	// ── Swipe handlers ───────────────────────────────────────────────
	function handleSwipe(event: { facadeId: string; decision: 'accept' | 'reject'; latencyMs: number }) {
		fetch('/api/swipe', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(event)
		}).catch((err) => console.error('[swipe] POST failed:', err));
	}

	function handleRemove(facadeId: string) {
		facades = facades.filter((f) => f.id !== facadeId);
	}
</script>

<!-- ── Intent entry ──────────────────────────────────────────────── -->
{#if mode === 'intent'}
	<div class="flex flex-col items-center justify-center min-h-screen gap-6 px-6">
		<h1
			class="text-4xl font-bold tracking-tight"
			style="font-family: var(--font-family-display); color: var(--color-on-surface);"
		>
			The Eye Loop
		</h1>
		<p class="text-sm" style="color: var(--color-outline);">
			Discover your taste through swipes. AI builds what you actually want.
		</p>

		<div class="flex gap-3 w-full max-w-md mt-4">
			<input
				type="text"
				bind:value={intentText}
				placeholder="What do you want to build?"
				disabled={loading}
				class="flex-1 rounded-xl px-4 py-3 text-sm outline-none"
				style="
					background: var(--color-surface-container);
					color: var(--color-on-surface);
					font-family: var(--font-family-body);
				"
				onkeydown={(e) => e.key === 'Enter' && startSession()}
			/>
			<button
				onclick={startSession}
				disabled={!intentText.trim() || loading}
				class="rounded-xl px-5 py-3 text-sm font-semibold transition-opacity disabled:opacity-40"
				style="
					background: var(--color-on-surface);
					color: var(--color-surface-lowest);
					font-family: var(--font-family-body);
				"
			>
				{loading ? 'Starting...' : 'Go'}
			</button>
		</div>

		{#if error}
			<p class="text-sm" style="color: var(--color-reject);">{error}</p>
		{/if}
	</div>

<!-- ── Swiping mode ──────────────────────────────────────────────── -->
{:else if mode === 'swiping'}
	<div class="h-screen flex flex-col" style="background: var(--color-surface-lowest);">
		<!-- Top bar -->
		<header class="flex items-center justify-between px-6 py-3 shrink-0">
			<h1
				class="text-sm font-bold uppercase tracking-[0.2em]"
				style="font-family: var(--font-family-display); color: var(--color-on-surface);"
			>
				The Eye Loop
			</h1>
			<div class="flex items-center gap-4">
				<span class="text-xs" style="color: var(--color-outline);">
					{evidence.length} swipes
				</span>
				<span
					class="text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full"
					style="background: var(--color-surface-container); color: var(--color-on-surface-variant);"
				>
					{stage}
				</span>
			</div>
		</header>

		<!-- Main grid -->
		<div
			class="grid grid-cols-1 md:grid-cols-[260px_1fr_340px] gap-4 flex-1 min-h-0 px-4 pb-4 max-w-[1440px] mx-auto w-full"
		>
			<!-- Left: Anima + Agents -->
			<div class="hidden md:flex flex-col gap-3 overflow-y-auto" style="scrollbar-width: thin;">
				<AnimaPanel {evidence} {synthesis} {antiPatterns} />
				<AgentStatus {agents} />
			</div>

			<!-- Center: Swipe feed -->
			<div class="flex items-center justify-center">
				<SwipeFeed {facades} onswipe={handleSwipe} onremove={handleRemove} />
			</div>

			<!-- Right: Draft -->
			<div class="hidden md:flex flex-col overflow-y-auto" style="scrollbar-width: thin;">
				<PrototypeDraftPanel {draft} mode="swiping" />
			</div>
		</div>
	</div>

	<!-- Mobile: collapsed panels below -->
	<div class="flex md:hidden flex-col gap-4 px-4 pb-4">
		<AgentStatus {agents} />
		<AnimaPanel {evidence} {synthesis} {antiPatterns} />
		<PrototypeDraftPanel {draft} mode="swiping" />
	</div>

<!-- ── Reveal mode ───────────────────────────────────────────────── -->
{:else if mode === 'reveal'}
	<div class="min-h-screen flex flex-col items-center p-4 md:p-8" style="background: var(--color-surface-lowest);">
		<header class="w-full max-w-4xl mb-8">
			<h1
				class="text-sm font-bold uppercase tracking-[0.2em]"
				style="font-family: var(--font-family-display); color: var(--color-on-surface);"
			>
				The Eye Loop
			</h1>
		</header>
		<div class="w-full max-w-4xl">
			<PrototypeDraftPanel {draft} mode="reveal" />
		</div>
	</div>
{/if}
