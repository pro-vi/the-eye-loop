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
	let flyingOff = $state<string | null>(null);
	let flyDirection = $state(0);

	// ── Derived ──────────────────────────────────────────────────────
	let topFacade = $derived(facades[0]);
	let visibleFacades = $derived(facades.slice(0, 3));

	// ── Card dimensions ──────────────────────────────────────────────
	const CARD_WIDTH = 340;
	const THRESHOLD = 0.3;

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
		const latencyMs = performance.now() - (startTime || performance.now());
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
				ontransitionend={isFlying ? ontransitionend : undefined}
				role="button"
				tabindex={isTop ? 0 : -1}
			>
				<!-- Hypothesis (debug only) -->
				{#if debug}
					<p
						class="px-5 pt-5 pb-2 text-[10px] uppercase tracking-[0.15em] leading-relaxed"
						style="color: var(--color-outline); font-family: var(--font-family-body);"
					>
						{facade.hypothesis}
					</p>
				{/if}

				<!-- Agent badge -->
				<span
					class="absolute top-4 right-4 text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider font-semibold"
					style="background: var(--color-surface-bright); color: var(--color-on-surface-variant);"
				>
					{facade.agentId}
				</span>

				<!-- Content area -->
				<div class="flex-1 flex flex-col items-center justify-center p-6 gap-3">
					{#if facade.format === 'word'}
						<p
							class="text-4xl font-black text-center leading-tight tracking-tight"
							style="font-family: var(--font-family-display); color: var(--color-on-surface);"
						>
							{facade.label}
						</p>
					{:else if facade.format === 'image' && facade.imageDataUrl}
						<img
							src={facade.imageDataUrl}
							alt={facade.hypothesis}
							class="w-full h-auto rounded-2xl object-cover max-h-72"
						/>
					{:else if facade.format === 'image'}
						<div class="text-center px-4">
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
							{/if}
						</div>
					{:else if facade.format === 'mockup'}
						<iframe
							srcdoc={facade.content}
							sandbox=""
							title={facade.hypothesis}
							class="rounded-2xl"
							style="width: 100%; height: 340px; border: none; pointer-events: none;"
						></iframe>
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
							✓
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
		<div class="flex items-center gap-8">
			<button
				onclick={() => buttonSwipe('reject')}
				class="w-12 h-12 rounded-full flex items-center justify-center text-lg transition-all hover:scale-110 active:scale-95"
				style="background: var(--color-surface-container); color: var(--color-reject);"
				aria-label="Reject"
			>
				✕
			</button>
			<p
				class="text-xs tracking-[0.15em] uppercase"
				style="color: var(--color-outline-variant); font-family: var(--font-family-body);"
			>
				swipe to decide
			</p>
			<button
				onclick={() => buttonSwipe('accept')}
				class="w-12 h-12 rounded-full flex items-center justify-center text-lg transition-all hover:scale-110 active:scale-95"
				style="background: var(--color-surface-container); color: var(--color-accept);"
				aria-label="Accept"
			>
				✓
			</button>
		</div>
	{/if}
</div>
