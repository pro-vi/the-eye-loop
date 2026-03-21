<script lang="ts">
	import type { Facade } from '$lib/context/types';

	interface VibeToken {
		label: string;
		decision: 'accept' | 'reject';
		sourceRect: DOMRect;
	}

	interface Props {
		facades: Facade[];
		debug?: boolean;
		onswipe: (event: { facadeId: string; decision: 'accept' | 'reject'; latencyMs: number }) => void;
		onremove: (facadeId: string) => void;
		onvibetoken?: (token: VibeToken) => void;
	}

	let { facades, debug = false, onswipe, onremove, onvibetoken }: Props = $props();

	// ── Gesture state ────────────────────────────────────────────────
	let deltaX = $state(0);
	let swiping = $state(false);
	let startX = 0;
	let startTime = 0;
	let cardShownAt = $state(performance.now()); // tracks when current top card appeared
	let flyingOff = $state<string | null>(null);
	let flyDirection = $state(0);

	// ── Derived ──────────────────────────────────────────────────────
	let topFacade = $derived(facades[0]);
	let visibleFacades = $derived(facades.slice(0, 3));

	const SCOUT_NAMES: Record<string, string> = {
		'scout-01': 'Iris',
		'scout-02': 'Prism',
		'scout-03': 'Lumen'
	};

	// Reset card timer when top card changes
	$effect(() => {
		if (topFacade) cardShownAt = performance.now();
	});

	// ── Card dimensions ──────────────────────────────────────────────
	const CARD_WIDTH = 340;
	const THRESHOLD = 0.3;
	const KEY_SWIPE_COOLDOWN_MS = 180;
	let lastKeyboardSwipe = $state(0);

	// ── Pointer handlers (top card only) ─────────────────────────────
	function onpointerdown(e: PointerEvent) {
		if (!topFacade || flyingOff) return;
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		startX = e.clientX;
		startTime = performance.now();
		swiping = true;
		deltaX = 0;
	}

	function onpointermove(e: PointerEvent) {
		if (!swiping) return;
		deltaX = e.clientX - startX;
	}

	function emitVibeToken(decision: 'accept' | 'reject', el?: HTMLElement) {
		if (!topFacade || !onvibetoken) return;
		const rect = el?.getBoundingClientRect() ?? new DOMRect(0, 0, CARD_WIDTH, 460);
		onvibetoken({ label: topFacade.label, decision, sourceRect: rect });
	}

	function onpointerup(e: PointerEvent) {
		if (!swiping || !topFacade) return;
		swiping = false;
		const el = e.currentTarget as HTMLElement;
		if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);

		const latencyMs = performance.now() - startTime;
		const ratio = Math.abs(deltaX) / CARD_WIDTH;

		if (ratio > THRESHOLD) {
			const decision = deltaX > 0 ? 'accept' : 'reject';
			flyDirection = deltaX > 0 ? 1 : -1;
			flyingOff = topFacade.id;
			onswipe({ facadeId: topFacade.id, decision, latencyMs });
			emitVibeToken(decision, e.currentTarget as HTMLElement);
		}

		deltaX = 0;
	}

	function onpointercancel(e: PointerEvent) {
		if (!swiping) return;
		const el = e.currentTarget as HTMLElement;
		if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
		swiping = false;
		deltaX = 0;
	}

	function onKeyDown(e: KeyboardEvent) {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		if (!topFacade || flyingOff) return;
		const target = e.target as HTMLElement | null;
		const tag = target?.tagName.toLowerCase();
		if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;

		const now = performance.now();
		if (now - lastKeyboardSwipe < KEY_SWIPE_COOLDOWN_MS) return;
		lastKeyboardSwipe = now;

		buttonSwipe(e.key === 'ArrowLeft' ? 'reject' : 'accept');
	}

	$effect(() => {
		if (!topFacade) return;

		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	});

	function ontransitionend(e: TransitionEvent) {
		if (e.propertyName !== 'transform' || !flyingOff) return;
		const id = flyingOff;
		flyingOff = null;
		flyDirection = 0;
		onremove(id);
	}

	// ── Button swipe (tap targets for accessibility) ─────────────────
	function buttonSwipe(decision: 'accept' | 'reject') {
		if (!topFacade || flyingOff) return;
		const latencyMs = performance.now() - cardShownAt;
		flyDirection = decision === 'accept' ? 1 : -1;
		flyingOff = topFacade.id;
		onswipe({ facadeId: topFacade.id, decision, latencyMs });
		const cardEl = document.querySelector('[role="button"][tabindex="0"]') as HTMLElement | null;
		emitVibeToken(decision, cardEl ?? undefined);
	}

	// ── Accept/reject indicator opacity ──────────────────────────────
	let acceptOpacity = $derived(swiping && deltaX > 0 ? Math.min(deltaX / (CARD_WIDTH * THRESHOLD), 1) : 0);
	let rejectOpacity = $derived(swiping && deltaX < 0 ? Math.min(-deltaX / (CARD_WIDTH * THRESHOLD), 1) : 0);
</script>

<div class="relative flex flex-col items-center justify-center gap-6" style="min-height: 560px;">
	<!-- Stage label (debug only) -->
	{#if topFacade && debug}
		<p
			class="text-xs uppercase tracking-[0.2em] font-semibold"
			style="color: var(--color-outline-variant); font-family: var(--font-family-display);"
		>
			{topFacade.format} stage
		</p>
	{/if}

	<!-- Card stack -->
	<div class="relative" style="width: {CARD_WIDTH}px; height: 460px;">
		{#each visibleFacades as facade, i (facade.id)}
			{@const isTop = i === 0}
			{@const isFlying = facade.id === flyingOff}
			{@const stackScale = 1 - i * 0.04}
			{@const stackY = i * 8}

			<div
				class="absolute inset-0 rounded-3xl overflow-hidden flex flex-col"
				style="
					background: var(--color-surface-container);
					box-shadow: 0px 20px 40px rgba(0, 0, 0, 0.4);
					z-index: {10 - i};
					transform: {isFlying
						? `translateX(${flyDirection * 150}%) rotate(${flyDirection * 15}deg)`
						: isTop && swiping
							? `translateX(${deltaX}px) rotate(${deltaX * 0.05}deg)`
							: `scale(${stackScale}) translateY(${stackY}px)`};
					opacity: {isFlying ? 0 : 1};
					transition: {isFlying
						? 'transform 0.3s ease-out, opacity 0.3s ease-out'
						: isTop && swiping
							? 'none'
							: 'transform 0.3s ease-out, opacity 0.3s ease-out'};
					touch-action: none;
					pointer-events: {isTop && !flyingOff ? 'auto' : 'none'};
				"
				onpointerdown={isTop ? onpointerdown : undefined}
				onpointermove={isTop ? onpointermove : undefined}
				onpointerup={isTop ? onpointerup : undefined}
				onpointercancel={isTop ? onpointercancel : undefined}
				ontransitionend={isFlying ? ontransitionend : undefined}
				role="button"
				tabindex={isTop ? 0 : -1}
			>
				<!-- Card header -->
				<div class="flex items-center justify-between px-5 pt-5 pb-2">
					<span
						class="text-[10px] uppercase tracking-[0.15em] font-medium truncate max-w-[210px]"
						title={facade.hypothesis}
						style="color: var(--color-outline); font-family: var(--font-family-display);"
					>
						{facade.hypothesis}
					</span>
					<span
						class="text-[10px] px-2.5 py-1 rounded-full uppercase tracking-wider font-semibold flex items-center gap-1.5"
						style="background: var(--color-surface-bright); color: var(--color-on-surface-variant);"
					>
						<span class="w-1.5 h-1.5 rounded-full" style="background: var(--color-accept);"></span>
						{SCOUT_NAMES[facade.agentId] ?? facade.agentId}
					</span>
				</div>

				<!-- Content area -->
				<div
					class="flex-1 flex flex-col items-center justify-center"
					class:p-6={facade.format === 'word'}
				>
					{#if facade.format === 'word'}
						<p
							class="text-5xl font-black text-center leading-none tracking-tight"
							style="font-family: var(--font-family-display); color: var(--color-on-surface);"
						>
							{facade.label}
						</p>
						<p
							class="text-sm text-center leading-relaxed mt-4 px-4 max-w-[280px]"
							style="color: var(--color-outline);"
						>
							{facade.hypothesis}
						</p>
					{:else if facade.format === 'image' && facade.imageDataUrl}
						<img
							src={facade.imageDataUrl}
							alt={facade.hypothesis}
							class="w-full h-full object-cover"
							style="border-radius: {Math.round(CARD_WIDTH * 0.04)}px;"
						/>
					{:else if facade.format === 'image'}
						<div class="text-center px-6">
							<p
								class="text-2xl font-bold leading-tight mb-3"
								style="font-family: var(--font-family-display); color: var(--color-on-surface);"
							>
								{facade.label}
							</p>
							{#if debug}
								<p class="text-xs leading-relaxed" style="color: var(--color-on-surface-variant);">
									{facade.content.slice(0, 150)}
								</p>
							{:else}
								<p class="text-xs leading-relaxed" style="color: var(--color-outline);">
									Image suggestion is warming up...
								</p>
							{/if}
						</div>
					{:else if facade.format === 'mockup'}
						<div class="w-full h-full overflow-hidden">
							<iframe
								srcdoc={facade.content}
								sandbox=""
								title={facade.hypothesis}
								style="border: none; pointer-events: none; width: 375px; height: 667px; transform: scale({CARD_WIDTH / 375}); transform-origin: top left;"
							></iframe>
						</div>
					{/if}
				</div>

				<!-- Swipe indicators (top card only) -->
				{#if isTop}
					<div
						class="absolute inset-0 rounded-3xl pointer-events-none flex items-center justify-between px-6"
					>
						<div
							class="w-14 h-14 rounded-full flex items-center justify-center text-2xl font-bold"
							style="
								background: rgba(239, 68, 68, {rejectOpacity * 0.15});
								color: var(--color-reject);
								opacity: {rejectOpacity};
								transition: opacity 0.1s;
							"
						>
							✕
						</div>
						<div
							class="w-14 h-14 rounded-full flex items-center justify-center text-2xl font-bold"
							style="
								background: rgba(34, 197, 94, {acceptOpacity * 0.15});
								color: var(--color-accept);
								opacity: {acceptOpacity};
								transition: opacity 0.1s;
							"
						>
							♥
						</div>
					</div>
				{/if}
			</div>
		{/each}

		<!-- Empty state -->
		{#if facades.length === 0}
			<div class="absolute inset-0 flex items-center justify-center">
				<div class="flex flex-col items-center gap-3">
					<div
						class="w-8 h-8 rounded-full animate-pulse"
						style="background: var(--color-surface-bright);"
					></div>
					<p class="text-xs" style="color: var(--color-outline-variant);">
						Scouts generating probes...
					</p>
				</div>
			</div>
		{/if}
	</div>

	<!-- Accept/Reject buttons -->
	{#if topFacade && !flyingOff}
		<div class="flex items-center gap-12">
			<div class="flex flex-col items-center gap-1.5">
				<button
					onclick={() => buttonSwipe('reject')}
					class="w-14 h-14 rounded-full flex items-center justify-center text-xl transition-all hover:scale-110 active:scale-95"
					style="background: var(--color-surface-container); color: var(--color-reject); border: 1px solid rgba(239, 68, 68, 0.2);"
					aria-label="Reject"
				>
					✕
				</button>
				<span class="text-[10px] uppercase tracking-widest font-medium" style="color: var(--color-outline-variant);">
					reject
				</span>
			</div>
			<div class="flex flex-col items-center gap-1.5">
				<button
					onclick={() => buttonSwipe('accept')}
					class="w-14 h-14 rounded-full flex items-center justify-center text-xl transition-all hover:scale-110 active:scale-95"
					style="background: var(--color-surface-container); color: var(--color-accept); border: 1px solid rgba(34, 197, 94, 0.2);"
					aria-label="Accept"
				>
					♥
				</button>
				<span class="text-[10px] uppercase tracking-widest font-medium" style="color: var(--color-outline-variant);">
					accept
				</span>
			</div>
		</div>
	{/if}

	<!-- Swipe hint -->
	<p
		class="text-[10px] tracking-[0.2em] uppercase"
		style="color: var(--color-outline-variant); font-family: var(--font-family-display);"
	>
		swipe to decide
	</p>
</div>
