<script lang="ts">
	import type { SwipeEvidence, TasteSynthesis } from '$lib/context/types';

	interface Props {
		evidence: SwipeEvidence[];
		synthesis: TasteSynthesis | null;
		antiPatterns: string[];
	}

	let { evidence, synthesis, antiPatterns }: Props = $props();

	let accepts = $derived(evidence.filter((e) => e.decision === 'accept'));
	let rejects = $derived(evidence.filter((e) => e.decision === 'reject'));
</script>

<div
	class="flex flex-col gap-5 rounded-2xl p-5"
	style="background: var(--color-surface); font-family: var(--font-family-body);"
>
	<h2
		class="text-sm font-semibold uppercase tracking-widest"
		style="color: var(--color-outline); font-family: var(--font-family-display);"
	>
		Anima
	</h2>

	<!-- Evidence tags -->
	{#if evidence.length > 0}
		<div class="flex flex-wrap gap-1.5">
			{#each evidence as e (e.facadeId)}
				{@const isAccept = e.decision === 'accept'}
				{@const isHesitant = e.latencySignal === 'slow'}
				<span
					class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs"
					style="
						background: {isAccept ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)'};
						color: {isAccept ? 'var(--color-accept)' : 'var(--color-reject)'};
					"
				>
					{isAccept ? '+' : '−'}{isHesitant ? '?' : ''}
					{e.content}
				</span>
			{/each}
		</div>

		<div class="flex gap-4 text-xs" style="color: var(--color-outline);">
			<span>{accepts.length} accepted</span>
			<span>{rejects.length} rejected</span>
		</div>
	{:else}
		<p class="text-sm" style="color: var(--color-outline-variant);">
			No evidence yet. Start swiping.
		</p>
	{/if}

	<!-- Synthesis -->
	{#if synthesis}
		<div class="flex flex-col gap-3">
			{#if synthesis.known.length > 0}
				<div>
					<p class="text-xs font-semibold uppercase tracking-wide mb-1" style="color: var(--color-accept);">Known</p>
					<ul class="flex flex-col gap-1">
						{#each synthesis.known as item}
							<li class="text-xs leading-relaxed" style="color: var(--color-on-surface-variant);">{item}</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if synthesis.unknown.length > 0}
				<div>
					<p class="text-xs font-semibold uppercase tracking-wide mb-1" style="color: var(--color-outline);">Unknown</p>
					<ul class="flex flex-col gap-1">
						{#each synthesis.unknown as item}
							<li class="text-xs leading-relaxed" style="color: var(--color-on-surface-variant);">{item}</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if synthesis.persona_anima_divergence}
				<div>
					<p class="text-xs font-semibold uppercase tracking-wide mb-1" style="color: var(--color-reject);">Divergence</p>
					<p class="text-xs leading-relaxed" style="color: var(--color-on-surface-variant);">
						{synthesis.persona_anima_divergence}
					</p>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Anti-patterns -->
	{#if antiPatterns.length > 0}
		<div>
			<p class="text-xs font-semibold uppercase tracking-wide mb-1.5" style="color: var(--color-reject);">
				Anti-patterns
			</p>
			<div class="flex flex-wrap gap-1.5">
				{#each antiPatterns as pattern}
					<span
						class="rounded-full px-2.5 py-1 text-xs"
						style="background: rgba(239, 68, 68, 0.08); color: var(--color-on-surface-variant);"
					>
						{pattern}
					</span>
				{/each}
			</div>
		</div>
	{/if}
</div>
