# Prior Systems

> Spec sections that reference this file: What It Does, Core Concepts: Eye

## Formal Basis

Each system below solved a subset of the same problem: recover a hidden internal
target from a human who cannot articulate it, using only behavioral responses to
generated stimuli. The shared formal skeleton is: (1) a latent space of possible
artifacts, (2) a hidden user-specific utility function, (3) a query policy that
selects informative stimuli, (4) a noisy observation channel (binary choice,
sometimes with timing), (5) a posterior update rule. What distinguishes Eye Loop
is combining all five with multimodal generation and structured UI. The
individual mechanisms are not new.

## Prior Art

**PbIG -- Preference-based Image Generation (2020, WACV).** Recovers a user's
mental image via pairwise comparisons over a pretrained generator's latent space.
No verbal description. Key result: pairwise comparison over generator latent
space is viable. Limitation: assumes a fixed target, no drift modeling.

**SwipeGANSpace (2024).** Swipe interaction to navigate interpretable GAN latent
directions. Critical finding: user preferences can CHANGE during interaction. The
target is co-constructed through selection. Implication: build in preference
drift modeling, not just convergence.

**GenIR -- Generative Image Retrieval (2025).** Multi-round interaction where
the model generates images concretizing its current understanding of the user's
target. Each image is a communication medium for the posterior state. Lesson:
generated stimuli are queries that externalize the model's belief for the user
to react to.

**Preference learning with response time (2025).** RT improves reward/preference
elicitation when modeled jointly with choice. Under drift-diffusion, RT encodes
decision difficulty and boundary proximity. Lesson: RT is first-class evidence.
Fast acceptance = high utility margin. Slow rejection = boundary proximity, not
necessarily low utility.

**EvoFIT (forensic facial composites).** Users select among candidate faces;
the system evolves a composite through selection/breeding without language.
Deployed in real forensic work. Lesson: selection-based interaction works when
language is unreliable. "Memory amplification" -- same skeleton as Eye Loop's
"taste amplification." Warning: presentation order, alternative count, and
repetition introduce systematic biases in any selection-based system.

**Reverse correlation.** Noise-based method: show randomly perturbed stimuli,
collect forced-choice judgments, reconstruct a "classification image" of the
observer's internal template. No verbalization required. Modern extensions
connect to compressive sensing. Eye Loop is a generalized reverse-correlation
engine: structured perturbations in generative parameter space replace pixel
noise around a fixed base.

**Mirror of Mind.** Reverse correlation applied to self-representation via
two-image forced choice. Demonstrates the method works for subjective, unstable
targets -- relevant to Eye Loop's claim that ambiguous stimuli reveal latent
self-structure through preference.

**Jungian framing (conceptual lens only).** Persona = explicit/socially
stabilized self-model. Anima = latent residual structure not captured by persona.
Projection = ambiguous stimuli cause residual structure to express through
preference. No broadly accepted mathematical formalization exists. Treat as
theory layer, not proof layer.

**GATE -- Generative Active Task Elicitation (ICLR 2025).** Edge-case
elicitation: generate scenarios exposing where stated preferences break down.
Reference only -- prompt template lives in specs/1-prompts.md.

**Multimodal shared representations.** Gemini (natively multimodal), CLIP /
ImageBind (contrastive/binding objectives placing modalities in one embedding).
Eye Loop needs the model to understand its own outputs: a shared latent space
where generated artifacts and preference predictors both live means each choice
buys information about nearby variations. Plausible but not fully settled.

## Warnings & Failure Modes

1. **Fixed-target assumption fails.** PbIG and classic reverse correlation
   assume a stable template. SwipeGANSpace disproved this. Eye Loop must model
   non-stationarity or it converges on a phantom.
2. **Projection vs confirmation.** Mere exposure increases liking. If the system
   shows similar variants repeatedly, the posterior drifts toward "familiar"
   rather than "true." Without exposure controls, Eye Loop confirms its own
   hypothesis.
3. **Language fallback abandons the core advantage.** EvoFIT and reverse
   correlation exist because verbal description fails. Falling back to words
   when the loop stalls is a regression.
4. **Presentation biases transfer.** EvoFIT documents that order, slate size,
   and repetition introduce systematic distortions in any selection-based system.
5. **Embedding quality is load-bearing.** If nearby embedding points do not
   correspond to perceptually similar artifacts, self-scoring becomes unreliable
   and controlled variation produces perceptual chaos.

## Implementation Patterns

**Pairwise comparison over latent space (from PbIG).** Maintain a preference
model (GP, Bradley-Terry) over the generator's latent space. Present pairs or
small slates. Update the posterior from each response. Select the next pair for
maximum information gain, not randomly.

**RT as continuous confidence channel.** Model observations as (choice, RT)
tuples. Weight posterior updates by inferred confidence: fast responses indicate
large utility margins, slow responses indicate boundary proximity.

**Drift-aware posterior (from SwipeGANSpace).** Time-decay old observations or
model non-stationary utility. Distinguish "changed mind" from "always
inconsistent at this resolution" using RT patterns.

**Structured perturbation (generalized reverse correlation).** Generate stimuli
by applying structured perturbations in generator parameter space. Aggregate
perturbation vectors by accept/reject to reconstruct the user's template as a
direction or region.

**Selection-only interaction (from EvoFIT).** The user's only required action is
choosing. No text, no sliders. Verbalization, if offered, is optional metadata
never fed to the inference engine.

**Shared embedding for self-scoring (from CLIP/ImageBind).** Embed candidates in
a multimodal space with meaningful distances. Use for slate dispersion, self-
scoring against the posterior target, and drift detection on locked constraints.

## Sources

- Kazemi et al., "Preference-Based Image Generation," WACV 2020 ([CVF][1])
- SwipeGANSpace, 2024 ([arXiv 2404.19693][2])
- GenIR, 2025 ([arXiv 2506.06220][3])
- Preference learning with RT, 2025 ([arXiv 2505.22820][4])
- EvoFIT forensic composites (research/0 S closest-systems, research/1 S projection)
- Reverse correlation / classification images (research/1 S projection)
- Mirror of Mind (research/1 S projection)
- GATE, ICLR 2025 (research/1 S projection)
- Gemini ([blog.google][5]), ImageBind ([CVPR 2023][6])
- Jung, CW7 (research/0 S6)

[1]: https://openaccess.thecvf.com/content_WACV_2020/papers/Kazemi_Preference-Based_Image_Generation_WACV_2020_paper.pdf
[2]: https://arxiv.org/pdf/2404.19693
[3]: https://arxiv.org/abs/2506.06220
[4]: https://arxiv.org/abs/2505.22820
[5]: https://blog.google/innovation-and-ai/technology/ai/google-gemini-ai/
[6]: https://openaccess.thecvf.com/content/CVPR2023/papers/Girdhar_ImageBind_One_Embedding_Space_To_Bind_Them_All_CVPR_2023_paper.pdf
