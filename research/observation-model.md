# Observation Model

> Spec sections that reference this file: Core Concepts: Eye, Observation Model, Data Structures, Facade Stages, Living Prototype

## Formal Basis

**Drift-Diffusion Model (DDM)**: RT and choice are jointly explained by
three latent parameters:

- **Drift rate (v)**: rate of evidence accumulation toward one option.
  Higher drift = stronger preference signal = faster, more accurate.
- **Boundary separation (a)**: how much evidence is needed before
  committing. Higher boundary = more cautious = slower but more accurate.
- **Non-decision time (t0)**: motor and encoding time unrelated to the
  decision process.

Evidence accumulates noisily from a starting point until it hits one of
two boundaries (accept or reject). Which boundary = choice; hitting
time + t0 = reaction time.

    RT = f(boundary_separation, drift_rate, noise) + non_decision_time

Critical insight: **RT reflects boundary proximity / decision difficulty,
NOT preference strength.** Slow does not mean dislike. Slow means the
stimulus sits near the indifference boundary -- evidence was weak or
conflicting. Fast accept and fast reject are both high-confidence; slow
accept and slow reject are both low-confidence.

**Joint choice+RT likelihood**: modeling choice alone discards half the
information. The DDM joint likelihood P(choice, RT | v, a, t0)
disambiguates: fast accept = strong positive; slow accept = weak
positive / near boundary; fast reject = strong negative; slow reject =
weak negative / near boundary. The slow cases are the most valuable for
learning because they identify the indifference surface.

**Psychometric functions**: in 2AFC, the standard threshold is **75%
correct** (midway between chance at 50% and ceiling at 100%). For Eye
Loop this maps stimulus "distance" in representation space to reliable
discrimination probability. The 75% threshold defines practical
resolution for a given user on a given axis.

**JND as stopping criterion**: the just-noticeable difference is the
smallest change a user can reliably detect. Once remaining candidate
differences fall below the user's stable JND, further optimization
produces imperceptible changes. Stop refining; lock the result, inject
novelty, or shift axes.

The JND floor is **local, not universal**. It varies by axis (color
temperature may have finer discrimination than texture density), by
region (discrimination sharpens near category boundaries), by user
expertise, and by session fatigue state.

**Weber's Law**: discrimination thresholds scale with stimulus magnitude
(delta_S / S = k, constant for a modality). Step sizes for axis sweeps
should scale proportionally with current position, not remain constant.

**Pairwise comparison vs accept/reject**: pairwise is better-conditioned
because it eliminates the implicit-threshold problem and maps directly
to Bradley-Terry / Thurstone scaling models. The spec uses accept/reject
(convention) -- a speed/simplicity tradeoff. Compensate with: RT-based
confidence estimation, periodic pairwise anchoring to detect threshold
drift, and modeling the implicit reference as a shifting latent variable.

**Acquired distinctiveness / equivalence**: after committing to a
category, discrimination sharpens on diagnostic sub-axes (acquired
distinctiveness) and blurs on irrelevant axes (acquired equivalence).
The observation model must not assume static discrimination across a
session. This is category-learning reshaping the observer's perceptual
resolution in real time.

## Prior Art

- **DDM (Ratcliff, 1978+)**: dominant sequential sampling model for
  joint RT + accuracy; validated across perceptual and value-based
  choice over four decades.
- **Attentional DDM**: RT correlates with value-comparison difficulty
  and attention allocation during evaluation.
- **Preference learning with response time (2025)**: RT improves
  preference/reward elicitation when modeled jointly with choice.
- **Reverse correlation / classification images**: ambiguous stimuli
  reveal internal representations via forced-choice. Eye Loop is a
  generalized reverse-correlation engine with structured perturbations
  in a generative parameter space.
- **EvoFIT**: forensic facial composites evolved via repeated selection
  without verbal description. Proves the interaction style works when
  language is unreliable.
- **Lavie & Tractinsky**: classical vs expressive aesthetics.
  **VisAWI (Moshagen & Thielsch)**: simplicity, diversity, colorfulness,
  craftsmanship.
- **Leder et al. stage model**: aesthetic processing from perception
  through evaluation, expertise modulating the pathway.

## Warnings & Failure Modes

1. **Mere exposure confound**: repeated exposure increases liking. The
   system shapes preference while measuring it. Without controls, the
   posterior drifts toward "familiar" not "preferred." Mitigate: novelty
   injection, time-decay on old evidence, explicit familiarity modeling.
2. **RT misinterpretation**: treating slow as "dislike" is the single
   most dangerous misread. Slow = near indifference = uncertainty.
3. **Threshold drift**: accept/reject against an implicit reference is
   vulnerable to silent criterion shifts (anchoring, fatigue,
   adaptation). Early and late responses become non-comparable.
4. **Below-JND refinement**: continuing past the discrimination floor
   trains on noise. The system learns random fluctuations.
5. **Motor-time contamination**: raw RT includes non-decision time.
   Without calibration, decision-time estimates are biased. Collect a
   few trivially easy trials to estimate the t0 baseline.

## Implementation Patterns

**Four-signal interpretation** -- every swipe yields (choice, RT):

| Choice | RT   | Signal            | Action                         |
|--------|------|-------------------|--------------------------------|
| Accept | Fast | Strong positive   | Amplify region                 |
| Accept | Slow | Weak / curious    | Near boundary; probe neighbors |
| Reject | Fast | Strong negative   | Suppress region                |
| Reject | Slow | Weak / unsure     | Near boundary; probe neighbors |

**RT calibration**: estimate t0 from the floor of the session's RT
distribution (fastest observed responses). Decision time = RT - t0.
Use decision time, not raw RT, for all confidence estimates.

**Local JND estimation**: hold parent path fixed, generate symmetric
small steps along the candidate axis, fit a psychometric curve from
choices, use RT to mark the near-boundary region. Operational JND =
smallest step with stable choice separation and faster RT away from
center.

**Stopping rule**: stop refining when remaining differences < local JND,
marginal IG drops below threshold, or RT variance spikes (fatigue).

**Exposure tracking**: tag stimuli with presentation count. Weight
updates by inverse exposure so the posterior does not conflate
"preferred" with "seen more often."

## Sources

- Ratcliff & McKoon, DDM; Krajbich et al., attentional DDM
- "Preference learning with response time" (2025)
- Thurstone, "Law of Comparative Judgment"; Bradley & Terry, BT model
- Zajonc, mere exposure effect; Weber's Law
- Lavie & Tractinsky; Moshagen & Thielsch (VisAWI); Leder et al.
- Goldstone, "Acquired distinctiveness and equivalence"
- Mangini & Biederman, reverse correlation / classification images
