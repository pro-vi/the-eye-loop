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

	// ── Vibe token animation ─────────────────────────────────────────
	function handleVibeToken(token: { label: string; decision: 'accept' | 'reject'; sourceRect: DOMRect }) {
		const overlay = document.getElementById('vibe-overlay');
		if (!overlay) return;

		const chip = document.createElement('div');
		chip.className = `vibe-token ${token.decision}`;
		chip.textContent = `${token.decision === 'accept' ? '✓' : '✗'} ${token.label}`;
		chip.style.left = `${token.sourceRect.x + token.sourceRect.width / 2}px`;
		chip.style.top = `${token.sourceRect.y + token.sourceRect.height / 2}px`;
		overlay.appendChild(chip);

		const targetEl = token.decision === 'accept'
			? document.getElementById('draft-panel')
			: document.getElementById('anti-patterns');
		const targetRect = targetEl?.getBoundingClientRect();
		const tx = targetRect ? targetRect.x + 40 : window.innerWidth - 100;
		const ty = targetRect ? targetRect.y + 20 : 100;

		chip.animate([
			{ left: chip.style.left, top: chip.style.top, scale: '1', opacity: '1' },
			{ left: `${tx}px`, top: `${ty}px`, scale: '0.6', opacity: '0.8' }
		], { duration: 400, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' })
			.finished.then(() => {
				chip.remove();
				targetEl?.classList.add(token.decision === 'accept' ? 'pulse-green' : 'pulse-red');
				setTimeout(() => targetEl?.classList.remove('pulse-green', 'pulse-red'), 300);
			});
	}
</script>

<style>
	:global(.vibe-token) {
		position: fixed;
		z-index: 50;
		padding: 4px 12px;
		border-radius: 9999px;
		font-size: 0.75rem;
		font-weight: 600;
		pointer-events: none;
		white-space: nowrap;
		transform: translate(-50%, -50%);
	}
	:global(.vibe-token.accept) { background: #22c55e; color: white; }
	:global(.vibe-token.reject) { background: #ef4444; color: white; }
	:global(.pulse-green) { box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.4); }
	:global(.pulse-red) { box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.4); }
</style>

<!-- Vibe token animation overlay -->
<div id="vibe-overlay" class="fixed inset-0 pointer-events-none z-50"></div>

<!-- ── Intent entry ──────────────────────────────────────────────── -->
{#if mode === 'intent'}
	<div
		class="relative flex flex-col items-center justify-center min-h-screen gap-8 px-6"
		style="background: var(--color-surface-lowest);"
	>
		<!-- Radial gradient glow -->
		<div
			class="absolute pointer-events-none"
			style="
				width: 600px; height: 400px;
				top: 50%; left: 50%;
				transform: translate(-50%, -60%);
				background: radial-gradient(ellipse, rgba(30,30,30,0.8) 0%, transparent 70%);
			"
		></div>

		<div class="relative flex flex-col items-center gap-4">
			<h1
				class="text-3xl md:text-5xl font-bold uppercase tracking-[0.2em]"
				style="font-family: var(--font-family-display); color: var(--color-on-surface);"
			>
				The Eye Loop
			</h1>
			<p class="text-sm" style="color: var(--color-outline); font-family: var(--font-family-body);">
				Swipe to vibe. AI builds what you actually want.
			</p>
		</div>

		<div class="relative flex gap-3 w-full max-w-lg">
			<input
				type="text"
				bind:value={intentText}
				placeholder="What do you want to build?"
				disabled={loading}
				class="flex-1 rounded-xl px-5 py-3.5 text-sm outline-none placeholder:text-[var(--color-outline-variant)]"
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
				class="rounded-xl px-6 py-3.5 text-sm font-bold uppercase tracking-wider transition-all disabled:opacity-30 hover:opacity-90 active:scale-95"
				style="
					background: var(--color-on-surface);
					color: var(--color-surface-lowest);
					font-family: var(--font-family-display);
				"
			>
				{loading ? '...' : 'GO \u2192'}
			</button>
		</div>

		{#if error}
			<p class="text-sm" style="color: var(--color-reject);">{error}</p>
		{/if}

		<!-- Example prompts -->
		<div class="relative flex gap-3 mt-2">
			{#each ['design playground', 'ai workspace', 'finance app'] as example}
				<button
					onclick={() => { intentText = example; }}
					class="text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-full transition-colors hover:opacity-80"
					style="background: var(--color-surface-container); color: var(--color-outline); font-family: var(--font-family-body);"
				>
					{example}
				</button>
			{/each}
		</div>
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
				<SwipeFeed {facades} onswipe={handleSwipe} onremove={handleRemove} onvibetoken={handleVibeToken} />
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
	<div class="min-h-screen flex flex-col" style="background: var(--color-surface-lowest);">
		<!-- Top bar -->
		<header class="flex items-center justify-between px-8 py-4 shrink-0">
			<h1
				class="text-sm font-bold uppercase tracking-[0.2em]"
				style="font-family: var(--font-family-display); color: var(--color-on-surface);"
			>
				The Eye Loop
			</h1>
			<div class="flex items-center gap-6">
				<span
					class="text-[10px] uppercase tracking-wider font-semibold"
					style="color: var(--color-on-surface); border-bottom: 1px solid var(--color-on-surface); padding-bottom: 2px;"
				>
					Gallery
				</span>
				<span class="text-[10px] uppercase tracking-wider" style="color: var(--color-outline);">
					{evidence.length} swipes
				</span>
			</div>
		</header>

		<!-- Reveal content -->
		<div class="flex-1 flex flex-col items-center px-6 py-8 md:py-16">
			<div class="w-full max-w-3xl flex flex-col items-center gap-10">
				<!-- Label + Title + Summary -->
				<div class="text-center">
					<p
						class="text-[10px] uppercase tracking-[0.3em] mb-4"
						style="color: var(--color-outline); font-family: var(--font-family-display);"
					>
						Final Prototype
					</p>
					{#if draft.title}
						<h2
							class="text-3xl md:text-5xl font-bold tracking-tight mb-4"
							style="font-family: var(--font-family-display); color: var(--color-on-surface);"
						>
							{draft.title}
						</h2>
					{/if}
					{#if draft.summary}
						<p
							class="text-base leading-relaxed max-w-xl mx-auto"
							style="color: var(--color-on-surface-variant); font-family: var(--font-family-body);"
						>
							{draft.summary}
						</p>
					{/if}
				</div>

				<!-- Phone frame -->
				<PrototypeDraftPanel {draft} mode="reveal" />

				<!-- Divergence insight -->
				{#if synthesis?.persona_anima_divergence}
					<div
						class="w-full max-w-lg rounded-2xl p-5"
						style="background: rgba(245, 158, 11, 0.06); border: 1px solid rgba(245, 158, 11, 0.12);"
					>
						<p class="text-[10px] font-semibold uppercase tracking-wider mb-2" style="color: #f59e0b;">
							Taste Divergence
						</p>
						<p class="text-sm leading-relaxed" style="color: var(--color-on-surface-variant);">
							{synthesis.persona_anima_divergence}
						</p>
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
