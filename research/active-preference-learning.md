# Active Preference Learning

> Spec sections that reference this file: Core Concepts: BALD, Core Concepts: Anima, Agent Spawning, Builder Loop, Orchestrator Watch, Builder-Driven Probes, Queue Equilibrium

## Formal Basis

**BALD** (Bayesian Active Learning by Disagreement) is a mutual-information
acquisition function. For parameters Theta, observation y, candidate x,
dataset D:

    BALD(x) = I(Theta; y | x, D)
            = H(y | x, D) - E_Theta[ H(y | x, Theta) ]

First term: predictive entropy (model uncertainty about the outcome).
Second term: expected posterior entropy (irreducible noise once parameters
are known). Their difference: how much the observation tells us about
the parameters.

**Conditional BALD per node**: for fract-tree node v with resolved parent
path c_v and local parameters Theta_v:

    BALD_v(x) = I(Theta_v; y | x, D, c_v)

Conditioning on c_v ensures only information about unresolved local
variables is measured. Conditional MI = 0 when the candidate axis is a
correlated echo of the parent rather than a genuinely new degree of
freedom.

**EPIG refinement**: BALD optimizes information about parameters; EPIG
optimizes information about future predictions. For Eye Loop the better
local objective is `I(O_x; Y_T(v) | D, c_v)` where O_x = (choice, RT)
and Y_T(v) are future responses in the active subtree. This avoids
BALD's tendency to chase obscure but downstream-irrelevant inputs.

**Frontier score** (surface vs depth selection -- the formula that
decides "surface-level or depth-fract?"):

    (v*, x*) = argmax [ P_t(v) * IG_v(x)
                         + beta * sqrt(ln(1+t) / (1+N_t(v)))
                         - gamma * d(v) ]

- P_t(v): posterior relevance mass of branch v
- IG_v(x): conditional information gain at node v for stimulus x
- N_t(v): probes already spent on node v
- d(v): depth of node v (penalizes depth greed)
- beta: exploration coefficient (UCB-style)
- gamma: depth penalty weight

Eligibility constraints: step size >= local JND; children enter the
frontier only after their parent locks (H_t(parent) < h_lock).

**AMPLe halving** (within-node shortcut): pick the query whose two
possible outcomes are closest to 0.5 under current belief -- generalized
binary search. Often faster than full MI computation and gives the same
halving behavior.

**Preferential BO link functions**: Bradley-Terry (logistic) or Thurstone
(probit) links convert latent utility differences into choice
probabilities: `P(A > B) = sigma(u(A) - u(B))`. GP priors over u(x)
with these likelihoods give the preferential GP framework.

**Convergence bounds**: discrete noiseless: log2(N). Continuous
d-dimensional to precision eps: ~d*log(1/eps). Sparse (k of d):
~k*log(d). Noise inflates all bounds; noisy twenty-questions theory
quantifies the penalty as a function of error rate.

**HOO/UCT for tree node selection**: hierarchical optimistic optimization
assigns each node an upper-confidence bound and recursively descends
toward high-payoff regions. The tree gets refined where it matters, not
uniformly. UCT gives the same explore-exploit logic on a growing tree.

## Prior Art

- **Bayesian optimal experimental design**: the general framework; BALD
  is the specific instance for classification/preference settings.
- **Query-by-committee (QBC)**: ensemble disagreement as query
  criterion; maps to multi-agent builder setups where models propose
  candidates and disagreement selects what to show.
- **Uncertainty sampling**: cheapest MI approximation, often competitive.
- **Preferential BO (PBO)**: optimizes latent functions queryable only
  via duels. Bridges classic BO with preference feedback.
- **Noisy twenty questions / probabilistic bisection**: the
  information-theoretic ancestor of the Akinator intuition.
- **Coarse-to-fine bandits (CoFineUCB)**: explore low-dimensional coarse
  space first, expand finer only when justified by evidence.
- **PbIG (WACV 2020)**: pairwise comparison over a generator latent
  space to recover a user's mental image.
- **SwipeGANSpace (2024)**: swipe interactions in GAN latent space;
  demonstrated that preferences change during interaction.
- **GenIR (2025)**: multi-round mental-image retrieval via generated
  stimuli as communication media for posterior state.

## Warnings & Failure Modes

1. **BALD over-exploration**: pure parameter-information objectives chase
   downstream-irrelevant inputs. Prefer predictive info (EPIG) when the
   goal is convergence on a usable artifact.
2. **Depth greed without parent lock**: probing children before the
   parent branch is confirmed wastes budget. Enforce the h_lock gate.
3. **Budget starvation of breadth**: too-small exploration bonus
   collapses onto one basin too early. Aesthetic landscapes are rugged
   and deceptive; the user's destination may not be the obvious one.
4. **Noise underestimation**: convergence bounds assume known noise
   models. Human choice noise is heteroskedastic -- varies with
   difficulty, fatigue, and familiarity.
5. **Static posterior on a moving target**: preferences drift via mere
   exposure and co-construction. Time-decay old evidence or track
   non-stationarity explicitly.
6. **Cross-branch leakage**: observations from one conditional branch
   contaminating another makes the posterior incoherent. Branch
   isolation is mandatory in conditional search spaces.

## Implementation Patterns

**Distribution flatness as hackathon BALD**: BALD is not computed from
LLM confidence (unreliable for aesthetic judgment). The orchestrator
watches accept/reject distribution across regions. Flat = high global
uncertainty; lopsided = convergence. Builder briefs target the flattest
region -- the practical equivalent of maximizing predictive entropy.

**Two-level controller**: outer loop (orchestrator) selects node v via
frontier score; inner loop (builder) generates stimulus x via conditional
BALD or AMPLe halving within that node.

**Cold start as a prior problem**: population priors, domain style
manifolds, or meta-learned initializations beat random seeding
dramatically. Seed with broad, semantically meaningful basis points.

**Dual model (attraction + repulsion)**: positive attractor (what to
amplify) plus negative exclusion (what to avoid). The negative model
constrains generation so queries skip dead regions. This is the AIS +
active learning synthesis.

## Sources

- Houlsby et al., BALD; Bickford Smith et al., EPIG
- Settles, "Active Learning Literature Survey" (uncertainty sampling, QBC)
- Jedynak et al., "Twenty Questions with Noise"
- Chu & Ghahramani, GP preference learning (Bradley-Terry)
- Gonzalez et al., Preferential BO; Bubeck et al., HOO/X-Armed Bandits
- Kazemi et al., PbIG (WACV 2020); SwipeGANSpace (2024); GenIR (2025)
- Jenatton et al., tree-structured BO; AMPLe, generalized binary search
