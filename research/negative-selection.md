# Negative Selection & AIS

> Spec sections that reference this file: Scout Loop, Core Concepts: Anima

## Formal Basis

Artificial immune systems (AIS) provide three computational mechanisms:

1. **Negative selection.** Generate candidate detectors. Eliminate those that
   match "self" (accepted region). Survivors detect "non-self" (forbidden
   territory). In preference terms: learn what the user rejects, build memory
   of rejected neighborhoods, stop wasting queries there.

2. **Clonal selection.** High-affinity detectors are cloned, hypermutated, and
   retained as memory cells. Clone accepted artifacts, mutate at varying step
   sizes, preserve high-affinity lineages.

3. **Immune network.** Multiple detector populations maintain diversity,
   preventing premature collapse onto a single aesthetic basin.

The dual-model pattern emerges directly: an **attraction model** (what to
amplify, from accepts + clonal selection) and a **repulsion model** (what to
avoid, from rejects + negative selection). Both are required.

## Prior Art

### Chao & Forrest: aesthetic immune system

The most directly relevant precedent. Builds reject-driven detectors over an
art parameter space: when a user labels an item as bad, the system constructs
a detector covering a neighborhood around that rejection. Over time, detectors
form a taste profile and the system continuously generates novel candidates
that avoid detected regions.

Key distinction from evolutionary search: rather than converging to a single
optimum, negative detection acts as a **perpetual novelty generator**
constrained by accumulated dislikes, without requiring population-level
fitness comparisons.

### Clonal selection algorithms (CLONALG, opt-aiNet)

Formalize the clone-mutate-select loop. Hypermutation is proportional to
affinity (low affinity = large mutations, high affinity = fine-grained).
Maps onto accepted artifacts spawning variant populations at decreasing
mutation radii.

## Warnings & Failure Modes

### The hole problem

Negative selection becomes hard in high-dimensional spaces near self/non-self
boundaries. Detector coverage becomes patchy: naive generate-and-test scales
poorly, and exponentially many samples are needed for reasonable boundary
coverage. The boundary is where the most interesting preference information
lives -- and where coverage is worst.

A repulsion model alone cannot be the whole engine. Pair it with a positive
utility model and an active query policy that probes regions where detector
coverage is weakest.

### Acquired distinctiveness vs acquired equivalence

After committing to a category, two asymmetric effects:

- **Acquired distinctiveness.** Discrimination along relevant dimensions can
  improve (sharpening near category boundaries).
- **Acquired equivalence.** Discrimination along irrelevant dimensions can
  blur (differences that do not predict membership become harder to notice).

Both effects typically require hundreds of trials. Within a single 30--40
swipe session, do not assume the user's discrimination has materially shifted.
Cross-session learning is where these effects become operational.

### Wine expertise analogy

Expert wine tasters show better recognition/identification but not necessarily
better raw sensitivity thresholds. Finer discrimination may require more
deliberation. An expert user's rejections carry more information per decision,
but the perceptual floor does not drop as much as intuition suggests.

### Entanglement of rejection and exposure

Rejecting a stimulus also creates exposure. The mere exposure effect can
increase liking near rejected regions, creating interference between the
repulsion model and familiarity-driven drift.

## Implementation Patterns

### Dual model: attraction + repulsion

- **Attraction model.** Learns positive utility from accepts. Predicts where
  the user is heading. Drives candidate generation near high-utility regions.
- **Repulsion model.** Learns forbidden neighborhoods from rejects. Constrains
  the generator to avoid known-dead regions.

Update both on every decision. An accept refines the attraction model and the
repulsion boundary. A reject updates the repulsion model and indirectly
constrains the attraction posterior.

### Local rejections reveal internal geometry

Once a parent region is "self" (accepted), local rejections within it carve
internal forbidden subregions. The geometry of rejections is diagnostic:

- Directions producing fast rejects from tiny steps are **active axes** --
  the user has strong preferences along that dimension.
- Directions tolerating large steps without flipping acceptance are **slack
  axes** -- the user is indifferent there.

This connects negative selection to orthogonal decomposition: rejection
geometry tells you which sub-axes are real. Expressible as local sensitivity
or boundary curvature estimation.

### Detector coverage strategy

Do not attempt uniform coverage in high dimensions (hole problem). Instead:

- Concentrate detectors near the current boundary estimate.
- Use active query selection to probe where coverage is weakest.
- Prune detectors far from the current frontier -- old rejections in
  abandoned regions are less valuable than fresh boundary data.

### Novelty generation via rejection constraints

The Chao & Forrest pattern: generate candidates, filter through the rejection
model, present only survivors. This produces a perpetual novelty stream
respecting accumulated taste without explicit diversity objectives. The sieve
guarantees candidates fall outside known-bad territory.

### Negative memory persistence across sessions

Rejection memory persists alongside accepted lineages. On session restart,
load both the repulsion model and the attraction model, then generate
candidates satisfying both constraints from the first swipe. This avoids
re-proposing artifacts the user has already dismissed.

## Sources

- research/0.md section 3 (AIS three mechanisms, negative selection as
  repulsion model, clonal selection as acceptance neighborhood search,
  immune network as diversity maintenance, hole problem)
- research/0.md section 3 (Chao & Forrest aesthetic immune system, reject-
  driven detectors, perpetual novelty generator, difference from evolutionary
  convergence)
- research/1.md section on AIS (self/non-self discrimination, dual model
  pattern, Chao & Forrest detail, clonal selection as iterative refinement)
- research/2.md section on connecting negative selection to fracting (local
  rejections inside self region, active vs slack axes from rejection geometry)
- research/3.md section 5 (acquired distinctiveness and equivalence, wine
  expertise analogy, within-session learning limitations)
