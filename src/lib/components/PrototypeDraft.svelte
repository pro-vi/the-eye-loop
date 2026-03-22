<script lang="ts">
	import type { PrototypeDraft } from '$lib/context/types';

	interface Props {
		draft: PrototypeDraft;
		mode: 'swiping' | 'reveal';
	}

	let { draft, mode }: Props = $props();

	let isReveal = $derived(mode === 'reveal');
	let hasPatterns = $derived(draft.acceptedPatterns.length > 0 || draft.rejectedPatterns.length > 0);

	// Force width constraint on LLM-generated HTML — the model ignores prompt rules
	const IFRAME_WRAPPER = '<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0;width:100%;overflow-x:hidden}</style>';
	let wrappedHtml = $derived(draft.html ? IFRAME_WRAPPER + draft.html : '');

	let draftState = $derived(
		draft.title || draft.summary || draft.html ? `${draft.acceptedPatterns.length} accepted / ${draft.rejectedPatterns.length} rejected` : 'Priming...'
	);
</script>

<div
	id="draft-panel"
	class="flex flex-col gap-4 rounded-2xl p-5 transition-shadow duration-300"
	style="
		background: var(--color-surface);
		font-family: var(--font-family-body);
		border: 1px solid rgba(255, 255, 255, 0.04);
	"
>
	<!-- Header -->
	<div class="flex flex-col gap-1">
		<div class="flex items-center justify-between gap-3">
		<h2
			class="text-xs font-semibold uppercase tracking-[0.2em]"
			style="color: var(--color-outline); font-family: var(--font-family-display);"
		>
			{isReveal ? 'Final Prototype' : 'Live Draft'}
		</h2>
		{#if draft.title && !isReveal}
			<span class="text-xs" style="color: var(--color-outline-variant);">
				{draft.title}
			</span>
		{/if}
		</div>
		<p class="text-[10px] tracking-wider" style="color: var(--color-on-surface-variant);">
			{draftState}
		</p>
	</div>

	<!-- Title + summary (reveal mode) -->
	{#if isReveal && draft.title}
		<div>
			<h2
				class="text-2xl font-bold"
				style="color: var(--color-on-surface); font-family: var(--font-family-display);"
			>
				{draft.title}
			</h2>
			{#if draft.summary}
				<p class="text-sm mt-2 leading-relaxed" style="color: var(--color-on-surface-variant);">
					{draft.summary}
				</p>
			{/if}
		</div>
	{/if}

	<!-- Phone frame + iframe -->
	<div
		class="relative mx-auto overflow-hidden"
		style="
			background: var(--color-surface-highest);
			border-radius: {isReveal ? '16px' : '32px'};
			padding: {isReveal ? '0' : '8px'};
			transition: all 0.5s ease-out;
			width: 100%;
			max-width: 100%;
		"
	>
		<!-- Phone notch (swiping mode only) -->
		{#if !isReveal}
			<div
				class="absolute top-0 left-1/2 -translate-x-1/2 z-10"
				style="
					width: 120px;
					height: 24px;
					background: var(--color-surface-highest);
					border-radius: 0 0 16px 16px;
				"
			></div>
		{/if}

		<div
			class="overflow-hidden"
			style="border-radius: {isReveal ? '16px' : '24px'};"
		>
		{#if wrappedHtml}
				<div
					style="
						width: 100%;
						height: {isReveal ? '80vh' : '560px'};
						overflow: hidden;
						transition: width 0.5s ease-out, height 0.5s ease-out;
					"
				>
					<iframe
						srcdoc={wrappedHtml}
						sandbox=""
						title={draft.title || 'Prototype draft'}
					style="
							border: none;
							display: block;
							width: 100%;
							height: 100%;
						"
					></iframe>
				</div>
			{:else}
				<div
					class="flex flex-col items-center justify-center gap-3 text-sm"
					style="
						width: {isReveal ? '100%' : '320px'};
						height: {isReveal ? '80vh' : '520px'};
						color: var(--color-outline-variant);
						background: var(--color-surface-container);
						transition: width 0.5s ease-out, height 0.5s ease-out;
					"
				>
					<div
						class="w-6 h-6 rounded-full animate-pulse"
						style="background: var(--color-surface-bright);"
					></div>
					<span class="text-xs">Waiting for builder...</span>
					<span class="text-[10px]">Prototype will react after your next swipe.</span>
				</div>
			{/if}
		</div>
	</div>

	<!-- Pattern chips -->
	{#if hasPatterns}
		<div id="anti-patterns" class="flex flex-wrap gap-1.5">
			{#each draft.acceptedPatterns as pattern}
				<span
					class="rounded-full px-2.5 py-1 text-[10px] font-medium"
					style="background: rgba(34, 197, 94, 0.12); color: var(--color-accept);"
				>
					{pattern}
				</span>
			{/each}
			{#each draft.rejectedPatterns as pattern}
				<span
					class="rounded-full px-2.5 py-1 text-[10px] font-medium line-through"
					style="background: rgba(239, 68, 68, 0.08); color: var(--color-reject);"
				>
					{pattern}
				</span>
			{/each}
		</div>
	{/if}

	<!-- Next hint alert -->
	{#if draft.nextHint}
		<div
			class="rounded-xl p-3"
			style="background: rgba(245, 158, 11, 0.06); border: 1px solid rgba(245, 158, 11, 0.15);"
		>
			<p class="text-[10px] font-semibold uppercase tracking-wider mb-1" style="color: #f59e0b;">
				Builder needs to know
			</p>
			<p class="text-xs leading-relaxed" style="color: var(--color-on-surface-variant);">
				{draft.nextHint}
			</p>
		</div>
	{/if}
</div>
