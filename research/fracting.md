# Fracting

> Spec sections that reference this file: Core Concepts: Fracting, Agent Spawning, Anima Compaction, Data Structures

## Formal Basis

**Fracting = conditional search in variable-dimensional space.**
Structurally identical to conditional/hierarchical configuration spaces
in Bayesian optimization and AutoML. Once a parent choice resolves
(e.g., "dark atmospheric"), new parameters activate that were previously
irrelevant. The effective dimensionality changes with the branch.

TPE models this as a tree-structured generative process. Arc-kernel BO
encodes which parameters are relevant per branch. Tree-structured BO
uses leaf-specific GPs with information sharing along overlapping paths
and a two-stage acquisition that first selects a promising leaf, then
optimizes locally within it.

**Conditional MI as axis-validity test**: for node v with parent path c_v:

    I(Theta_v; y | x, D, c_v)

If this equals zero, the candidate child variable is conditionally
independent of the observation -- a correlated echo of the parent, not a
new axis. This is the formal version of "is this really a new child
axis, or just the parent in a different hat?"

**Conditional-VOI for depth vs breadth**: open children only if the
parent is sufficiently resolved:

    open children of n only if H_t(n) < h_lock

Then go deeper only if the best child probe beats the best surface probe:

    max child score > max surface score + delta

where the frontier score is:

    S_t(v,x) = P_t(v) * IG_v(x)
               + beta * sqrt(ln(1+t) / (1+N_t(v)))
               - gamma * d(v)

Surface and child nodes compete in one frontier. Highest conditional
predictive value wins. This is the Eye Loop version of coarse-to-fine
UCB.

**Progressive widening from MCTS**: do not expand a node's action set
until it has enough visits to justify expansion. HOO/UCT assign
upper-confidence bounds per node and descend toward high-payoff regions.
The tree refines where it matters. Fracting is literally progressive
widening of the preference-action space.

**Local tangent-space estimation** for discovering sub-axes: local PCA
on neighborhood samples around the accepted anchor estimates the tangent
space. Top eigenvectors become candidate axes. Residual PCA (regress out
the parent component) reveals orthogonal structure the parent masked.
ICA/ISA breaks rotational ambiguity for truly independent factors; HSIC
provides independence testing.

**Conjoint-style interaction discovery** for axes that only matter in
combination: generate a 2x2 (low/high) factorial micro-batch on two
candidate axes. Non-additive response patterns reveal interaction
effects. If fog_density only matters when "dark atmospheric" is active,
it is a child axis. If it matters regardless, it is top-level.

## Prior Art

- **TPE**: tree-structured Parzen estimator for hierarchical spaces.
- **Arc-kernel BO / Tree-structured BO (Jenatton et al.)**: conditional
  parameter spaces with leaf-specific GPs and path-based sharing.
- **CoFineUCB / Hier-UCB**: coarse-to-fine bandits; explore
  low-dimensional space first, expand as needed.
- **HOO / UCT**: hierarchical optimistic optimization for tree-structured
  explore-exploit allocation.
- **Mixtures of factor analyzers**: joint clustering + local
  dimensionality reduction for multimodal resolved regions.
- **Conjoint analysis**: interaction effects formalize when attributes
  matter only in combination.
- **ICA / ISA**: independent subspaces via non-Gaussianity; sisPCA adds
  supervision while encouraging disentanglement.
- **Picbreeder**: branching across sessions for depth beyond single-user
  fatigue. Single-user sessions ~20 generations; cumulative lineages
  ~151.

## Warnings & Failure Modes

1. **Entanglement by default**: LLM-generated "axes" will be correlated
   (multi-attribute control literature). Assume entangled until verified
   via user feedback or decomposition methods.
2. **Branch isolation violation**: observations from one conditional
   branch must not leak into another. Use branch-aware kernels or
   factored beliefs: `p(Theta|D) = p(branch v|D) * p(Theta_v|D, c_v)`.
3. **Depth budget**: 2 levels reliable, 3 max on one strong branch,
   never >3 in 30 swipes. Forcing 4-5 levels trains on patience, not
   taste.
4. **Max 3 iterative image edits before drift**: Gemini-style editing
   accumulates locked-dimension drift. Each fract level consuming an
   edit round constrains depth for image facades.
5. **Fake-orthogonal axes**: perceptually entangled despite
   generator-space independence. Test empirically: if preference shifts
   correlate with drift on locked dimensions, the axis is not clean.
6. **Premature depth**: probing children before parent confirmation
   wastes budget. Enforce h_lock eligibility.
7. **Hole problem at depth**: negative selection becomes patchy in high
   dimensions near boundaries. Pair repulsion with positive utility
   modeling; rejection alone cannot navigate depth.

## Implementation Patterns

**Session budget** (30 swipes): ~10 breadth (4-6 top-level regions,
high-IG queries) / ~15 depth (lock winning branch, resolve ~2 sub-axes
at 6-8 swipes each) / ~5 refine (finals + novelty probes). On return
sessions with stable tree top, flip ratio toward depth. Real depth comes
from persistent lineages across sessions, not one heroic swipe binge.

**RT-gated depth**: fast + consistent RT at current depth = user
demonstrates discriminability, expand one more level. Slow + inconsistent
= stop fracting, return to breadth or artifact production mode.

**Subspace discovery recipe**: (1) collect accepted + near-boundary
rejects within parent node; (2) encode in shared embedding;
(3) residualize locked parent features; (4) local PCA/cPCA for candidate
directions; (5) mixture of factor analyzers if multimodal; (6) prune
via HSIC/ICA/orthogonality score; (7) only then ask Gemini to name
directions. Let the model label axes; do not let it invent them.

**Gemini sweep template** (prompt lives in specs/1-prompts.md): attach
best accepted image as reference, lock all resolved parent attributes,
vary exactly one operational child axis over 5 levels, require JSON
self-audit with drift scores on locked dimensions. If audit shows
repeated drift, reject the batch and treat the axis as entangled.
Operationalize axes as measurable controls (fog density, blur magnitude,
grain size, color temperature) not vibes.

**Node data**: path locks, local preference posterior, candidate child
axes, node-specific JND estimates, accepted exemplars, near-boundary
rejects, generation template, visit count N_t(v), posterior mass P_t(v).
**Stop signals**: best child score below threshold; all probes below
local JND floor; AMPLe halving stalls; conditional MI collapses; RT
variance spikes.

## Sources

- Jenatton et al., tree-structured BO; Bergstra et al., TPE
- Houlsby et al., BALD; Bickford Smith et al., EPIG; Bubeck et al., HOO
- AMPLe, generalized binary search; Hyvarinen et al., ICA/ISA
- Goldstone, acquired distinctiveness/equivalence
- Sylcott et al., visual conjoint; multi-attribute controllable generation
- Secretan et al., Picbreeder; Takagi, IEC survey (fatigue bounds)
- Google Gemini image generation/editing docs
