# IEC Fatigue & Representation

> Spec sections that reference this file: Agent Roster, Scout Loop, Facade Stages

## Formal Basis

Interactive evolutionary computation (IEC) replaces an explicit fitness function
with subjective human evaluation. The human becomes the bottleneck, not the
search algorithm. Two quantities dominate every IEC system's practical ceiling:

1. **Per-session generation limit.** Single-user IEC sessions typically stall
   after roughly 10--20 generations. Beyond that, choice quality degrades and
   the system is effectively learning the user's fatigue curve, not their taste.

2. **Binary-decision budget.** Across paradigms (accept/reject, pairwise,
   rating), cognitive fatigue and indifference rise after approximately 30--40
   binary-scale decisions in a single sitting. This is not a theorem; it is an
   empirical regularity reported across IEC surveys and corroborated by
   psychophysics literature on sustained forced-choice tasks.

The implication is a hard budget: design every session loop to extract maximum
information from roughly 30--40 atomic judgments, not more.

## Prior Art

### Picbreeder and cumulative lineages

Picbreeder is the strongest quantitative case study. Key numbers:

- Single-user sessions averaged ~20 generations.
- Cumulative lineages (across users, via branching) averaged ~151 generations.
- 98% of top-rated images required more than 20 cumulative generations.

The lesson is not "users are lazy." It is that **depth belongs to persistent
lineages, not single-session endurance.** A system that discards session history
and starts fresh each time will never reach the complexity tier where the
interesting artifacts live.

### Branching as fatigue escape hatch

Picbreeder's critical UX mechanism was branching: users could start from an
existing artifact rather than from scratch, inheriting a partially explored
lineage. This converts the problem from "one user does 151 generations" to
"many users each contribute 10--20 generations of refinement on a shared tree."

For any Eye Loop session, the cold start should not be random. Seed with:

- Broad, semantically meaningful basis points (coarse style anchors).
- Reusable branches from prior sessions or from a population prior.

### Novelty-assisted IEC

A complementary mitigation: let automation handle boring exploration while the
human does strategic steering. Novelty-assisted IEC reduces the number of
direct human judgments by offloading diversity maintenance and local search to
the algorithm, reserving human attention for directional commits and boundary
decisions.

## Warnings & Failure Modes

### Representation is destiny

NEAT/CPPN-style encodings work in Picbreeder because they produce regularity,
symmetry, and meaningful local variation. Small genotype changes correspond to
coherent perceptual changes rather than pixel noise. If the generator's latent
space does not support interpretable, incremental variation, the user
experiences the loop as random search. Fatigue spikes. IEC history is
essentially a museum of this failure mode.

Bad latent space = random search experience = catastrophic fatigue.

### Hill-climbing trap on rugged landscapes

Aesthetic landscapes are rugged and deceptive. A system that only hill-climbs
around current favorites will miss the side road that turns out to be the
user's actual destination. Diversity and stepping stones must be maintained
explicitly: preserve multiple candidate lineages, inject novelty, and resist
the temptation to converge too early.

### Mere exposure confound

Repeated exposure increases liking (mere exposure effect). In an iterative
loop, the system is not just measuring preference -- it is shaping it. Without
novelty injection or explicit non-stationarity handling, the posterior drifts
toward "familiar" rather than "true."

### Cold-start randomness

Starting from random seeds wastes the most valuable swipes (the first ones,
when the user is freshest and most engaged). Those early decisions should cut
the broadest axes -- mood, palette family, structural complexity -- not
evaluate noise.

## Implementation Patterns

### Session budget allocation (30-swipe reference)

A defensible allocation for a single fresh session:

- ~10 swipes on breadth: find top-level regions with high posterior mass.
- ~15 swipes on depth: lock one winning branch and resolve ~2 sub-axes
  (6--8 swipes per sub-axis including calibration and boundary probes).
- ~5 swipes on refinement: generate finals, plus 1--2 novelty/robustness
  probes or seeds for the next session's branch.

### Cross-session lineage persistence

Real depth comes from branching across sessions, not single-session marathons.
The system must persist:

- Accepted exemplars and their lineage paths.
- Locked parent axes and their parameter values.
- Near-boundary rejects (negative memory for repulsion models).
- The generation templates used at each node.

On return sessions, the top of the tree is already stable. Flip the budget
ratio toward depth.

### RT-gated depth control

Use reaction time as a gating signal for depth:

- Fast RT + consistent choices at depth: expand one more level.
- Slow RT + inconsistent choices: stop fracting, return to breadth or switch
  to artifact-production mode (recognition over evaluation).

### Automation layer

Offload to agents:

- Diversity maintenance across candidate populations.
- Local mutation and interpolation around accepted anchors.
- Novelty injection to counteract mere-exposure drift.

Reserve for humans:

- Strategic directional commits (which branch to pursue).
- Boundary decisions (accept/reject at the frontier of uncertainty).

## Sources

- research/0.md section 4 (IEC, Picbreeder, novelty-assisted IEC, CPPN/NEAT
  representation, cold start, diversity/stepping stones, fatigue limits)
- research/1.md section on IEC (fatigue as dominant bottleneck, Picbreeder
  branching data, representation-as-destiny, mitigation strategies)
- research/2.md sections on IEC fatigue ceiling, practical depth limits,
  session budget allocation, RT-gated depth control
- research/3.md section 7 (Picbreeder cumulative lineage statistics,
  practical dimensionality and session limits, 30-swipe budget allocation)
