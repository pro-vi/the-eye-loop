<script lang="ts">
	import type { AgentState } from '$lib/context/types';

	interface Props {
		agents: AgentState[];
	}

	let { agents }: Props = $props();

	const statusConfig: Record<AgentState['status'], { color: string; label: string }> = {
		thinking: { color: '#f59e0b', label: 'Thinking...' },
		waiting: { color: '#3b82f6', label: 'Waiting' },
		idle: { color: 'var(--color-accept)', label: 'Idle' },
		queued: { color: 'var(--color-outline)', label: 'Queued' }
	};
</script>

<div
	class="flex flex-col gap-4 rounded-2xl p-5"
	style="background: var(--color-surface); font-family: var(--font-family-body);"
>
	<h2
		class="text-sm font-semibold uppercase tracking-widest"
		style="color: var(--color-outline); font-family: var(--font-family-display);"
	>
		Agents
	</h2>

	{#if agents.length === 0}
		<p class="text-sm" style="color: var(--color-outline-variant);">No agents active.</p>
	{:else}
		<div class="flex flex-col gap-3">
			{#each agents as agent (agent.id)}
				{@const cfg = statusConfig[agent.status]}
				<div class="flex items-start gap-3">
					<!-- Status dot -->
					<div class="mt-1 flex-shrink-0">
						<div
							class="h-2.5 w-2.5 rounded-full"
							class:animate-pulse={agent.status === 'thinking'}
							style="background: {cfg.color};"
						></div>
					</div>

					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<span class="text-sm font-semibold" style="color: var(--color-on-surface);">
								{agent.name}
							</span>
							<span
								class="rounded-full px-2 py-0.5 text-xs"
								style="background: var(--color-surface-container); color: {cfg.color};"
							>
								{cfg.label}
							</span>
						</div>

						{#if agent.focus}
							<p class="text-xs italic mt-0.5 truncate" style="color: var(--color-outline);">
								{agent.focus}
							</p>
						{/if}
					</div>

					<!-- Role badge -->
					<span
						class="text-xs rounded-full px-2 py-0.5 flex-shrink-0"
						style="background: var(--color-surface-bright); color: var(--color-on-surface-variant);"
					>
						{agent.role}
					</span>
				</div>
			{/each}
		</div>
	{/if}
</div>
