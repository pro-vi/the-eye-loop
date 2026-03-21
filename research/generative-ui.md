# Generative UI

> Spec sections that reference this file: Core Concepts: Facades, Queue Equilibrium

## Formal Basis

The facade queue is a query in a Bayesian experimental design sense, not a
deliverable. Two formal frames apply:

1. **Dispersion as an objective.** Design Galleries (Marks et al., SIGGRAPH 1997)
   formalized candidate-set selection: given a parameterized design space, choose
   parameter vectors whose outputs are perceptually dispersed, then arrange them
   for browsable navigation. Dispersion and arrangement are first-class
   algorithmic subproblems. Coverage of the output manifold matters more than any
   single candidate's predicted quality -- the goal is information gain.

2. **Sequential query-efficient traversal.** Sequential Gallery extended Design
   Galleries with Bayesian optimization to traverse an n-dimensional design space
   using few user queries. This bridges "gallery browsing" and "active preference
   learning."

3. **UI synthesis as constrained optimization.** SUPPLE (Gajos & Weld) framed
   interface generation as decision-theoretic optimization over users, devices,
   and tasks. UI artifacts are structured objects with hard constraints;
   synthesis is optimization over that structure, not free-form text generation.

## Prior Art

- **Design Galleries** (SIGGRAPH 1997): generate many parameter-space samples,
  ensure perceptual dispersion, let the user navigate by selection.
- **Sequential Gallery**: BO over design parameters with a preference surrogate.
  Reduces queries from exhaustive browsing to directed search.
- **SUPPLE**: UI generation as constrained decision-theoretic optimization,
  proving feasibility even when the theoretical UI space is enormous.
- **Rico dataset**: large-scale UI hierarchy dataset enabling learning-based
  layout generation via structural metadata.
- **LayoutDM / discrete diffusion**: layout generation emphasizing
  controllability, quality, and diversity under constraints.
- **Structured intermediate representations**: recent work argues that UI
  semantics, layout constraints, and design-system tokens enable meaningful
  comparison and variation. Raw text-to-code does not.
- **UI-Bench / WebGen-Bench**: benchmarks showing LLM UI generation has serious
  functional brittleness. Functional accuracy is far from "trust blindly."
- **Generative and Malleable UI** workshop line: direct code generation is a
  poor foundation for iterative end-user tailoring.

## Warnings & Failure Modes

1. **Redundancy kills information gain.** If the queue shows perceptually
   near-identical candidates, every response after the first carries almost
   no new information. Dispersion is not optional.
2. **Unstructured generation prevents meaningful mutation.** Without shared
   parameterization, there is no way to compute distances, enforce constraints,
   or generate controlled variations. Structured intermediate representations
   are prerequisites for adaptive search rather than random sampling.
3. **LLM UI generation is brittle under functional constraints.** Current
   benchmarks show generated interfaces frequently fail functional requirements
   even when they look plausible. Use the LLM as a proposal engine, not a final
   renderer.
4. **A/B testing logic does not transfer.** A/B estimates population-average
   treatment effects across many users and few fixed variants. Eye Loop is the
   inverse: within-user adaptive experiment, changing variants on the fly.
   The correct operational cousins are contextual bandits, dueling bandits, and
   preferential Bayesian optimization -- not fixed-allocation A/B.
5. **Arrangement matters.** Design Galleries explicitly formalized arrangement
   as an algorithmic problem. Dumping candidates in arbitrary order degrades
   the user's ability to form coherent comparisons.

## Implementation Patterns

**Dispersion-first generation.** Sample the design-parameter space, then filter
for perceptual dispersion on embeddings or rendered outputs. Show a slate that
covers the posterior uncertainty region, not one clustered around the MAP.

**Structured intermediate layer.** Anchor generation in design-system tokens,
layout constraint vectors, or component grammars. Mutations operate on this
layer; rendering is downstream. Enables distance computation, single-axis
variation, constraint enforcement, and interpretable change logs.

**Inverse A/B (within-user adaptive).** Each facade presentation is a trial in
a per-user sequential experiment. Use contextual bandit or preferential BO
acquisition functions. Update the posterior after each response. Never run a
fixed allocation across rounds.

**Two-stage LLM usage.** Stage 1 (proposal): generate structured candidates
from the current parameter region. Stage 2 (validation): re-embed, check
constraints, compute dispersion, reject or re-sample before presentation.

**Parameterized bandit arms.** Treat each facade as a bandit arm parameterized
by its design-token vector, so observing one response informs predictions about
nearby arms in parameter space.

## Sources

- Marks et al., "Design Galleries," SIGGRAPH 1997 ([MERL TR97-14][1])
- Sequential Gallery: BO for design-parameter traversal (research/0 S5)
- Gajos & Weld, SUPPLE (research/1 S generative-UI)
- Rico dataset, LayoutDM, discrete diffusion layout models (research/1 S generative-UI)
- UI-Bench, WebGen-Bench (research/0 S5, research/1 S generative-UI)
- Generative and Malleable UI ([arXiv 2508.20410][2])
- Contextual bandits, dueling bandits, preferential BO (research/0 S5, research/1)

[1]: https://www.merl.com/publications/docs/TR97-14.pdf
[2]: https://arxiv.org/abs/2508.20410
