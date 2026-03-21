<script lang="ts">
	import type { Facade } from '$lib/context/types';

	interface Props {
		facades: Facade[];
		onswipe: (event: { facadeId: string; decision: 'accept' | 'reject'; latencyMs: number }) => void;
		onremove: (facadeId: string) => void;
	}

	let { facades, onswipe, onremove }: Props = $props();

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

	function onpointerup(_e: PointerEvent) {
		if (!swiping || !topFacade) return;
		swiping = false;

		const latencyMs = performance.now() - startTime;
		const ratio = Math.abs(deltaX) / CARD_WIDTH;

		if (ratio > THRESHOLD) {
			// Commit swipe
			const decision = deltaX > 0 ? 'accept' : 'reject';
			flyDirection = deltaX > 0 ? 1 : -1;
			flyingOff = topFacade.id;

			onswipe({ facadeId: topFacade.id, decision, latencyMs });
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

	// ── Accept/reject indicator opacity ──────────────────────────────
	let acceptOpacity = $derived(swiping && deltaX > 0 ? Math.min(deltaX / (CARD_WIDTH * THRESHOLD), 1) : 0);
	let rejectOpacity = $derived(swiping && deltaX < 0 ? Math.min(-deltaX / (CARD_WIDTH * THRESHOLD), 1) : 0);
</script>

<div class="relative flex flex-col items-center justify-center" style="min-height: 560px;">
	<!-- Card stack -->
	<div class="relative" style="width: {CARD_WIDTH}px; height: 480px;">
		{#each visibleFacades as facade, i (facade.id)}
			{@const isTop = i === 0}
			{@const isFlying = facade.id === flyingOff}
			{@const stackScale = 1 - i * 0.05}
			{@const stackY = i * 10}

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
				<!-- Hypothesis -->
				<p
					class="px-4 pt-4 pb-2 text-xs uppercase tracking-widest"
					style="color: var(--color-outline); font-family: var(--font-family-body);"
				>
					{facade.hypothesis}
				</p>

				<!-- Agent badge -->
				<span
					class="absolute top-3 right-3 text-xs px-2.5 py-1 rounded-full"
					style="background: var(--color-surface-bright); color: var(--color-on-surface-variant);"
				>
					{facade.agentId}
				</span>

				<!-- Content area -->
				<div class="flex-1 flex items-center justify-center p-6">
					{#if facade.format === 'word'}
						<p
							class="text-4xl font-bold text-center leading-tight"
							style="font-family: var(--font-family-display); color: var(--color-on-surface);"
						>
							{facade.label}
						</p>
					{:else if facade.format === 'image' && facade.imageDataUrl}
						<img
							src={facade.imageDataUrl}
							alt={facade.hypothesis}
							class="w-full h-auto rounded-2xl object-cover max-h-80"
						/>
					{:else if facade.format === 'mockup'}
						<iframe
							srcdoc={facade.content}
							sandbox=""
							title={facade.hypothesis}
							class="rounded-2xl"
							style="width: 375px; height: 360px; border: none; pointer-events: none;"
						></iframe>
					{/if}
				</div>

				<!-- Swipe indicators (top card only) -->
				{#if isTop}
					<div
						class="absolute inset-0 rounded-3xl pointer-events-none flex items-center justify-between px-6"
					>
						<div
							class="text-3xl font-bold"
							style="color: var(--color-reject); opacity: {rejectOpacity};"
						>
							✕
						</div>
						<div
							class="text-3xl font-bold"
							style="color: var(--color-accept); opacity: {acceptOpacity};"
						>
							✓
						</div>
					</div>
				{/if}
			</div>
		{/each}
	</div>

	<!-- Swipe counter -->
	{#if facades.length > 0}
		<p
			class="mt-8 text-sm tracking-wide"
			style="color: var(--color-outline); font-family: var(--font-family-body);"
		>
			Swipe to decide
		</p>
	{/if}
</div>
