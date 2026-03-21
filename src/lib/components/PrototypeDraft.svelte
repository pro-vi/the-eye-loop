<script lang="ts">
	import type { PrototypeDraft } from '$lib/context/types';

	interface Props {
		draft: PrototypeDraft;
		mode: 'swiping' | 'reveal';
	}

	let { draft, mode }: Props = $props();

	let isReveal = $derived(mode === 'reveal');
	let hasPatterns = $derived(draft.acceptedPatterns.length > 0 || draft.rejectedPatterns.length > 0);
</script>

<div class="flex flex-col gap-4" style="font-family: var(--font-family-body);">
	<!-- Title + summary (reveal mode) -->
	{#if isReveal && draft.title}
		<div class="mb-2">
			<h2
				class="text-2xl font-bold"
				style="color: var(--color-on-surface); font-family: var(--font-family-display);"
			>
				{draft.title}
			</h2>
			{#if draft.summary}
				<p class="text-base mt-2" style="color: var(--color-on-surface-variant);">
					{draft.summary}
				</p>
			{/if}
		</div>
	{/if}

	<!-- Draft iframe -->
	<div
		class="rounded-2xl overflow-hidden"
		style="
			background: var(--color-surface-container);
			transition: all 0.5s ease-out;
		"
	>
		{#if draft.html}
			<iframe
				srcdoc={draft.html}
				sandbox=""
				title={draft.title || 'Prototype draft'}
				style="
					border: none;
					width: {isReveal ? '100%' : '375px'};
					height: {isReveal ? '80vh' : '667px'};
					transition: width 0.5s ease-out, height 0.5s ease-out;
				"
			></iframe>
		{:else}
			<div
				class="flex items-center justify-center text-sm"
				style="
					width: {isReveal ? '100%' : '375px'};
					height: {isReveal ? '80vh' : '667px'};
					color: var(--color-outline-variant);
					transition: width 0.5s ease-out, height 0.5s ease-out;
				"
			>
				Waiting for builder...
			</div>
		{/if}
	</div>

	<!-- Next hint alert -->
	{#if draft.nextHint}
		<div
			class="rounded-xl p-3.5"
			style="background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.2);"
		>
			<p class="text-xs font-semibold uppercase tracking-wide mb-1" style="color: #f59e0b;">
				Builder needs to know
			</p>
			<p class="text-sm leading-relaxed" style="color: var(--color-on-surface-variant);">
				{draft.nextHint}
			</p>
		</div>
	{/if}

	<!-- Pattern chips -->
	{#if hasPatterns}
		<div class="flex flex-col gap-2">
			{#if draft.acceptedPatterns.length > 0}
				<div class="flex flex-wrap gap-1.5">
					{#each draft.acceptedPatterns as pattern}
						<span
							class="rounded-full px-2.5 py-1 text-xs"
							style="background: rgba(34, 197, 94, 0.12); color: var(--color-accept);"
						>
							{pattern}
						</span>
					{/each}
				</div>
			{/if}

			{#if draft.rejectedPatterns.length > 0}
				<div class="flex flex-wrap gap-1.5">
					{#each draft.rejectedPatterns as pattern}
						<span
							class="rounded-full px-2.5 py-1 text-xs line-through"
							style="background: rgba(239, 68, 68, 0.08); color: var(--color-reject);"
						>
							{pattern}
						</span>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>
