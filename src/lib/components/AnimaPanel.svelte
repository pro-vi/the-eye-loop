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

	const confidenceColors: Record<TasteSynthesis['axes'][number]['confidence'], string> = {
		unprobed: 'var(--color-outline-variant)',
		exploring: '#f59e0b',
		leaning: '#3b82f6',
		resolved: 'var(--color-accept)'
	};
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
					title={e.content}
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

	<!-- Oracle synthesis -->
	{#if synthesis}
		<!-- Emergent axes -->
		{#if synthesis.axes.length > 0}
			<div class="flex flex-col gap-2.5">
				<p
					class="text-xs font-semibold uppercase tracking-wide"
					style="color: var(--color-outline);"
				>
					Taste Axes
				</p>
				{#each synthesis.axes as axis (axis.label)}
					{@const confColor = confidenceColors[axis.confidence]}
					{@const leaningA = axis.leaning_toward === axis.poleA}
					{@const leaningB = axis.leaning_toward === axis.poleB}
					<div
						class="rounded-xl px-3 py-2"
						style="background: var(--color-surface-container);"
					>
						<div class="flex items-center justify-between mb-1">
							<span class="text-xs font-semibold" style="color: var(--color-on-surface);">
								{axis.label}
							</span>
							<span
								class="text-xs rounded-full px-2 py-0.5"
								style="background: var(--color-surface-bright); color: {confColor};"
							>
								{axis.confidence}
							</span>
						</div>
						<div class="flex justify-between text-xs">
							<span style="color: {leaningA ? confColor : 'var(--color-on-surface-variant)'};">
								{axis.poleA}
							</span>
							<span style="color: {leaningB ? confColor : 'var(--color-on-surface-variant)'};">
								{axis.poleB}
							</span>
						</div>
						{#if axis.leaning_toward}
							<p class="text-xs mt-1" style="color: {confColor};">
								→ {axis.leaning_toward}
							</p>
						{/if}
						{#if axis.evidence_basis}
							<p class="text-[10px] leading-relaxed mt-2" style="color: var(--color-outline-variant);">
								<span style="color: var(--color-outline);">basis:</span> {axis.evidence_basis}
							</p>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<!-- Edge case flags -->
		{#if synthesis.edge_case_flags.length > 0}
			<div class="flex flex-wrap gap-1.5">
				{#each synthesis.edge_case_flags as flag (flag)}
					<span
						class="rounded-full px-2.5 py-1 text-xs"
						style="background: rgba(245, 158, 11, 0.1); color: #f59e0b;"
					>
						{flag}
					</span>
				{/each}
			</div>
		{/if}

		<!-- Divergence -->
		{#if synthesis.persona_anima_divergence}
			<div>
				<p class="text-xs font-semibold uppercase tracking-wide mb-1" style="color: var(--color-reject);">Divergence</p>
				<p class="text-xs leading-relaxed" style="color: var(--color-on-surface-variant);">
					{synthesis.persona_anima_divergence}
				</p>
			</div>
		{/if}
	{/if}

	<!-- Anti-patterns -->
	{#if antiPatterns.length > 0}
		<div>
			<p class="text-xs font-semibold uppercase tracking-wide mb-1.5" style="color: var(--color-reject);">
				Anti-patterns
			</p>
			<div class="flex flex-wrap gap-1.5">
				{#each antiPatterns as pattern (pattern)}
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
