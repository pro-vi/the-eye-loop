# P1 Taste: Axis Seeding — Design Taste Dimensions

Model: `gemini-3.1-flash-lite-preview`
Temperature: 0
Date: 2026-03-21

## Prompt Used

```
You are seeding initial taste axes for The Eye Loop — a system that discovers what a user wants to build through instinctive selection (swipe accept/reject), not specification.

The user's intent: "{INTENT}"

Generate exactly 5 binary taste axes. These are DESIGN TASTE dimensions, not CSS properties.

Each axis will be probed at progressively concrete levels:
- First as a single evocative WORD (e.g., "Precision" vs "Warmth")
- Then as a MOODBOARD IMAGE (e.g., Swiss grid design vs hand-crafted illustration)
- Then as an HTML MOCKUP (e.g., dense data dashboard vs spacious narrative page)

RULES:
- Each axis captures a PRODUCT EXPERIENCE choice, not a visual property
- Poles should be nameable design philosophies, product references, or interaction paradigms
- Good: "information stance: observatory dashboard vs companion narrative"
- Good: "visual heritage: swiss modernism vs organic craft"
- Good: "interaction model: direct manipulation vs guided flow"
- Bad: "corner-radius: 0px vs 24px" (this is a CSS property, not taste)
- Bad: "color-saturation: grayscale vs vibrant" (this is a visual knob, not a design philosophy)
- Bad: "layout-alignment: center vs left" (this is a layout detail, not a product decision)
- Each axis must be INTENT-SPECIFIC — it should matter for THIS product, not be a generic design axis
- Poles must be roughly equally appealing — avoid "good vs bad" framings
- For each axis, provide a concrete example of how it would appear as a word-stage facade and an image-stage facade

id should be kebab-case.
```

## Aggregate Scores

| Metric | Value |
|--------|-------|
| Average axis count | 5.0 (target: 5) |
| Average taste-level axes | 3.0 |
| Average CSS-level leaks | 0.0 (target: 0) |

## Per-Intent Results

### "weather app for runners"
5 axes | 4 taste | 0 css-leaks | 3230ms

| Axis | Pole A | Pole B | Taste | CSS |
|------|--------|--------|:-----:|:---:|
| **Data Philosophy** (data-philosophy) | Clinical Precision | Intuitive Readiness | ✓ |  |
| **Narrative Voice** (narrative-voice) | The Coach | The Environment | ✓ |  |
| **Temporal Focus** (temporal-focus) | The Immediate Now | The Planning Horizon |  |  |
| **Interaction Paradigm** (interaction-paradigm) | Active Exploration | Passive Glance | ✓ |  |
| **Aesthetic Heritage** (aesthetic-heritage) | Performance Sport | Urban Lifestyle | ✓ |  |

**Word facades:**
- data-philosophy: "Telemetry" vs "Readiness"
- narrative-voice: "Directive" vs "Atmospheric"
- temporal-focus: "Instant" vs "Strategic"
- interaction-paradigm: "Interactive" vs "Ambient"
- aesthetic-heritage: "Technical" vs "Lifestyle"

**Image facades:**
- data-philosophy: "A high-density, multi-metric cockpit display with precise numerical readouts and technical graphs." vs "A single, large, color-coded status indicator showing a simple 'Go' or 'Wait' signal based on conditions."
- narrative-voice: "A bold, typography-heavy interface with motivational text and structured training intervals." vs "A soft, immersive interface focusing on light, wind, and texture to convey the feeling of the outdoors."
- temporal-focus: "A minimalist, single-screen view showing only the current conditions for the next 60 minutes." vs "A calendar-integrated view showing a week-long outlook to optimize training schedules."
- interaction-paradigm: "A complex, map-based interface allowing the user to pan and zoom to check micro-climates." vs "A widget-first design optimized for lock-screen viewing and quick, one-tap status checks."
- aesthetic-heritage: "High-contrast, neon-accented design reminiscent of professional athletic gear and stopwatches." vs "Muted, sophisticated color palettes and clean, editorial-style typography suited for daily wear."

### "personal finance app that doesn't feel like a spreadsheet"
5 axes | 3 taste | 0 css-leaks | 3661ms

| Axis | Pole A | Pole B | Taste | CSS |
|------|--------|--------|:-----:|:---:|
| **Cognitive Load Model** (cognitive-load-model) | Analytical Observatory | Intuitive Companion | ✓ |  |
| **Temporal Perspective** (temporal-perspective) | Historical Ledger | Future Projection |  |  |
| **Interaction Paradigm** (interaction-paradigm) | Direct Manipulation | Guided Narrative | ✓ |  |
| **Visual Heritage** (visual-heritage) | Swiss Modernism | Organic Craft | ✓ |  |
| **Feedback Style** (feedback-style) | Quantitative Metrics | Qualitative Signals |  |  |

**Word facades:**
- cognitive-load-model: "Precision" vs "Empathy"
- temporal-perspective: "Retrospective" vs "Aspirational"
- interaction-paradigm: "Control" vs "Flow"
- visual-heritage: "Structured" vs "Human"
- feedback-style: "Objective" vs "Subjective"

**Image facades:**
- cognitive-load-model: "A dense, multi-column financial dashboard with complex charts and tabular data." vs "A single, soft-focus card showing a conversational summary of the user's financial health."
- temporal-perspective: "A detailed transaction history list with categorized spending logs." vs "A visual timeline showing a growing savings goal with progress bars and milestone markers."
- interaction-paradigm: "A spreadsheet-like interface with editable cells and filter toggles." vs "A step-by-step interactive storybook interface that guides the user through financial decisions."
- visual-heritage: "A clean, grid-based layout with bold typography and strict alignment." vs "A layout featuring soft rounded shapes, hand-drawn icons, and warm, textured backgrounds."
- feedback-style: "A screen dominated by percentage changes, raw numbers, and performance indices." vs "A screen using color-coded mood indicators and simple status icons to represent financial well-being."

### "portfolio site for an architect"
5 axes | 2 taste | 0 css-leaks | 3142ms

| Axis | Pole A | Pole B | Taste | CSS |
|------|--------|--------|:-----:|:---:|
| **Architectural Narrative Style** (architectural-narrative-style) | The Monograph | The Field Journal | ✓ |  |
| **Navigation Paradigm** (navigation-paradigm) | The Blueprint | The Walkthrough | ✓ |  |
| **Project Representation** (project-representation) | The Object | The Process |  |  |
| **Brand Voice** (brand-voice) | The Institution | The Atelier |  |  |
| **Information Density** (information-density) | The Archive | The Showcase |  |  |

**Word facades:**
- architectural-narrative-style: "Curated" vs "Raw"
- navigation-paradigm: "Structured" vs "Immersive"
- project-representation: "Polished" vs "Evolutionary"
- brand-voice: "Authoritative" vs "Personal"
- information-density: "Comprehensive" vs "Cinematic"

**Image facades:**
- architectural-narrative-style: "A minimalist, high-contrast gallery of finished building photography with ample white space." vs "A collage of site sketches, material samples, and construction site candid photos."
- navigation-paradigm: "A clean, grid-based index page with clear categorical filtering and project metadata." vs "A full-screen, scroll-triggered experience that mimics moving through a physical space."
- project-representation: "High-fidelity architectural renders and final building shots." vs "Diagrams, section cuts, and iterative design development sketches."
- brand-voice: "Typography-heavy layout with serif fonts and formal, academic project descriptions." vs "Handwritten annotations, informal project notes, and a focus on the architect's philosophy."
- information-density: "A dense, searchable database of all past works with technical specifications." vs "A sparse, high-impact visual display focusing on one hero project at a time."

### "meditation timer with ambient soundscapes"
5 axes | 1 taste | 0 css-leaks | 2853ms

| Axis | Pole A | Pole B | Taste | CSS |
|------|--------|--------|:-----:|:---:|
| **Temporal Presence** (temporal-presence) | Chronometric Precision | Fluid Duration |  |  |
| **Soundscape Agency** (soundscape-agency) | Curated Soundscapes | Generative Environments |  |  |
| **Interaction Philosophy** (interaction-philosophy) | Active Engagement | Passive Immersion | ✓ |  |
| **Visual Grounding** (visual-grounding) | Digital Minimalism | Analog Texture |  |  |
| **Guidance Style** (guidance-style) | Structured Coaching | Open-Ended Sanctuary |  |  |

**Word facades:**
- temporal-presence: "Clockwork" vs "Ebb"
- soundscape-agency: "Composition" vs "Ecosystem"
- interaction-philosophy: "Control" vs "Surrender"
- visual-grounding: "Glass" vs "Grain"
- guidance-style: "Mentor" vs "Void"

**Image facades:**
- temporal-presence: "A high-contrast digital stopwatch with millisecond precision and sharp sans-serif typography" vs "A soft-focus, slow-motion video of ink diffusing in water with no visible numbers"
- soundscape-agency: "A clean, grid-based library of distinct, labeled audio tracks like 'Rain' or 'Forest'" vs "A chaotic, beautiful abstract particle field that shifts color and density based on ambient noise"
- interaction-philosophy: "A tactile, knob-heavy interface reminiscent of a vintage synthesizer" vs "A single, glowing orb that pulses slowly, requiring only a tap to begin or end"
- visual-grounding: "A frosted-glass UI with crisp, thin lines and high-transparency layers" vs "A warm, paper-textured background with hand-drawn charcoal icons and soft shadows"
- guidance-style: "A progress-tracking dashboard with streaks, badges, and step-by-step meditation guides" vs "A vast, empty horizon line at dusk with no text or indicators, just the sound of wind"

### "recipe app for people who hate cooking"
5 axes | 3 taste | 0 css-leaks | 3700ms

| Axis | Pole A | Pole B | Taste | CSS |
|------|--------|--------|:-----:|:---:|
| **Cognitive Load Strategy** (cognitive-load-strategy) | Minimalist Automation | Guided Empowerment | ✓ |  |
| **Content Presentation Style** (content-presentation-style) | Utility-First Data | Narrative-First Storytelling | ✓ |  |
| **Interaction Philosophy** (interaction-philosophy) | Direct Manipulation | Conversational Flow | ✓ |  |
| **Visual Atmosphere** (visual-atmosphere) | Clinical Efficiency | Domestic Warmth |  |  |
| **Outcome Focus** (outcome-focus) | Speed and Survival | Experience and Discovery |  |  |

**Word facades:**
- cognitive-load-strategy: "Autopilot" vs "Coach"
- content-presentation-style: "Blueprint" vs "Journal"
- interaction-philosophy: "Control" vs "Dialogue"
- visual-atmosphere: "Laboratory" vs "Kitchen"
- outcome-focus: "Fuel" vs "Craft"

**Image facades:**
- cognitive-load-strategy: "A single button interface with a clean, empty screen" vs "A step-by-step interactive checklist with progress indicators"
- content-presentation-style: "A dense, structured table of ingredients and times" vs "A full-bleed, high-quality photograph with conversational text"
- interaction-philosophy: "A dashboard with draggable widgets and filter toggles" vs "A chat-like interface with natural language prompts"
- visual-atmosphere: "Monochromatic, high-contrast, sans-serif typography" vs "Soft textures, warm lighting, and serif accents"
- outcome-focus: "A timer-centric view emphasizing 'ready in 5 minutes'" vs "A discovery-centric view emphasizing 'explore new flavors'"

### "dating profile builder"
5 axes | 3 taste | 0 css-leaks | 3224ms

| Axis | Pole A | Pole B | Taste | CSS |
|------|--------|--------|:-----:|:---:|
| **Narrative Structure** (narrative-structure) | Curated Portfolio | Dynamic Journal | ✓ |  |
| **Social Signaling** (social-signaling) | Status-Driven | Vulnerability-Driven |  |  |
| **Interaction Paradigm** (interaction-paradigm) | Guided Interview | Freeform Canvas | ✓ |  |
| **Information Density** (information-density) | Data-Rich | Atmospheric |  |  |
| **Aesthetic Heritage** (aesthetic-heritage) | Digital Brutalism | Analog Nostalgia | ✓ |  |

**Word facades:**
- narrative-structure: "Gallery" vs "Chronicle"
- social-signaling: "Prestige" vs "Authenticity"
- interaction-paradigm: "Structured" vs "Expressive"
- information-density: "Analytical" vs "Evocative"
- aesthetic-heritage: "Modernist" vs "Vintage"

**Image facades:**
- narrative-structure: "A clean, high-fashion editorial layout with large, static hero images." vs "A scrolling, scrapbook-style feed with overlapping photos and handwritten notes."
- social-signaling: "Minimalist, high-contrast typography with sharp, architectural framing." vs "Soft, warm-toned photography with candid, unposed moments."
- interaction-paradigm: "A step-by-step wizard interface with clear progress indicators." vs "A blank, infinite-scroll canvas where elements can be dragged and dropped anywhere."
- information-density: "A profile featuring detailed stats, interest tags, and structured bio sections." vs "A profile dominated by a single, full-bleed image with minimal, poetic text."
- aesthetic-heritage: "Monospaced fonts, raw borders, and a stark, utilitarian color palette." vs "Film grain textures, serif typography, and muted, sepia-leaning tones."

### "indie game studio landing page"
5 axes | 5 taste | 0 css-leaks | 2686ms

| Axis | Pole A | Pole B | Taste | CSS |
|------|--------|--------|:-----:|:---:|
| **Studio Identity Archetype** (studio-identity-archetype) | The Artisan Workshop | The Tech-Forward Lab | ✓ |  |
| **Narrative Engagement Style** (narrative-engagement-style) | The Immersive Storyteller | The Transparent Developer | ✓ |  |
| **Information Architecture Philosophy** (information-architecture-philosophy) | The Curated Gallery | The Comprehensive Archive | ✓ |  |
| **Interaction Paradigm** (interaction-paradigm) | The Playful Explorer | The Efficient Professional | ✓ |  |
| **Community Connection Model** (community-connection-model) | The Cult-Brand Hub | The Industry Authority | ✓ |  |

**Word facades:**
- studio-identity-archetype: "Craftsmanship" vs "Innovation"
- narrative-engagement-style: "Atmospheric" vs "Pragmatic"
- information-architecture-philosophy: "Minimalist" vs "Encyclopedic"
- interaction-paradigm: "Whimsical" vs "Functional"
- community-connection-model: "Intimate" vs "Authoritative"

**Image facades:**
- studio-identity-archetype: "A textured, warm-toned photo of a wooden desk with sketches and physical prototypes" vs "A clean, high-contrast render of a glowing server rack and digital interface"
- narrative-engagement-style: "A cinematic, moody landscape shot from a game world with deep shadows" vs "A clear, well-lit photo of a team collaborating in a bright, open-plan office"
- information-architecture-philosophy: "A single, high-impact hero image with minimal text overlay" vs "A dense, organized grid of project thumbnails, release notes, and team bios"
- interaction-paradigm: "A screenshot of a website with custom cursor effects and animated transitions" vs "A screenshot of a website with standard, high-speed navigation and clear call-to-action buttons"
- community-connection-model: "A collage of fan art, Discord community highlights, and behind-the-scenes social posts" vs "A professional layout featuring press accolades, technical whitepapers, and industry awards"

### "collaborative playlist curator for road trips"
5 axes | 3 taste | 0 css-leaks | 3574ms

| Axis | Pole A | Pole B | Taste | CSS |
|------|--------|--------|:-----:|:---:|
| **Curation Philosophy** (curation-philosophy) | Algorithmic Autonomy | Human-Centric Agency | ✓ |  |
| **Social Dynamic** (social-dynamic) | Democratic Consensus | Curator-Led Authority |  |  |
| **Temporal Focus** (temporal-focus) | Real-Time Spontaneity | Planned Narrative | ✓ |  |
| **Information Density** (information-density) | Data-Rich Dashboard | Atmospheric Minimalist |  |  |
| **Interaction Paradigm** (interaction-paradigm) | Gamified Engagement | Utility-First Workflow | ✓ |  |

**Word facades:**
- curation-philosophy: "Automated" vs "Manual"
- social-dynamic: "Collective" vs "Authoritative"
- temporal-focus: "Improvisational" vs "Structured"
- information-density: "Analytical" vs "Evocative"
- interaction-paradigm: "Playful" vs "Functional"

**Image facades:**
- curation-philosophy: "A sleek, minimalist interface showing a single 'Play' button with a glowing AI-generated waveform" vs "A tactile, scrapbook-style interface with drag-and-drop vinyl record icons and handwritten notes"
- social-dynamic: "A circular voting interface where multiple user avatars orbit a central track queue" vs "A single-column feed with a prominent 'Host' badge and a clear hierarchy of track suggestions"
- temporal-focus: "A fast-paced, high-contrast interface with a 'Now Playing' focus and ephemeral track transitions" vs "A timeline-based interface resembling a film strip, allowing for precise sequencing of songs"
- information-density: "A dense grid of metadata, BPM counters, and genre tags with a technical, dark-mode aesthetic" vs "A spacious, full-screen blurred album art background with only essential playback controls"
- interaction-paradigm: "A vibrant, card-based interface with swipe-to-vote animations and progress-bar badges" vs "A clean, list-based interface with standard checkboxes and clear, professional typography"

### "plant care tracker with watering reminders"
5 axes | 2 taste | 0 css-leaks | 3386ms

| Axis | Pole A | Pole B | Taste | CSS |
|------|--------|--------|:-----:|:---:|
| **Botanical Relationship** (botanical-relationship) | Scientific Monitoring | Nurturing Companionship |  |  |
| **Temporal Focus** (temporal-focus) | Predictive Scheduling | Responsive Observation |  |  |
| **Data Density** (data-density) | Comprehensive Overview | Focused Moment | ✓ |  |
| **Interaction Cadence** (interaction-cadence) | Proactive Notification | Passive Discovery |  |  |
| **Aesthetic Philosophy** (aesthetic-philosophy) | Digital Utility | Organic Tactility | ✓ |  |

**Word facades:**
- botanical-relationship: "Diagnostics" vs "Caregiving"
- temporal-focus: "Optimization" vs "Presence"
- data-density: "Dashboard" vs "Snapshot"
- interaction-cadence: "Alert" vs "Ambient"
- aesthetic-philosophy: "System" vs "Texture"

**Image facades:**
- botanical-relationship: "clinical-lab-chart-interface" vs "warm-hand-drawn-journal-style"
- temporal-focus: "automated-calendar-grid-view" vs "slow-living-daily-log-view"
- data-density: "dense-multi-column-data-table" vs "single-hero-plant-card-layout"
- interaction-cadence: "push-notification-heavy-ui" vs "subtle-status-indicator-ui"
- aesthetic-philosophy: "clean-minimalist-sans-serif-ui" vs "paper-grain-and-serif-typography-ui"

### "freelancer invoice and time tracking tool"
5 axes | 4 taste | 0 css-leaks | 3409ms

| Axis | Pole A | Pole B | Taste | CSS |
|------|--------|--------|:-----:|:---:|
| **Accounting Philosophy** (accounting-philosophy) | Clinical Precision | Humanistic Flow | ✓ |  |
| **Time Tracking Paradigm** (time-tracking-paradigm) | Active Intent | Passive Observation | ✓ |  |
| **Client Relationship Tone** (client-relationship-tone) | Professional Detachment | Collaborative Partnership |  |  |
| **Data Density Preference** (data-density-preference) | Command Center | Focused Workspace | ✓ |  |
| **Visual Heritage** (visual-heritage) | Swiss Modernism | Digital Brutalism | ✓ |  |

**Word facades:**
- accounting-philosophy: "Ledger" vs "Journal"
- time-tracking-paradigm: "Stopwatch" vs "Ambient"
- client-relationship-tone: "Formal" vs "Relational"
- data-density-preference: "Overview" vs "Task"
- visual-heritage: "Structured" vs "Raw"

**Image facades:**
- accounting-philosophy: "High-density spreadsheet interface with monospaced typography and strict grid lines" vs "Soft-edged card-based interface with conversational prompts and warm color accents"
- time-tracking-paradigm: "Prominent, high-contrast timer button with active countdown state" vs "Minimalist background status bar with subtle activity indicators"
- client-relationship-tone: "Crisp, corporate-style invoice templates with sharp borders and formal serif headers" vs "Friendly, message-integrated invoice views with profile avatars and project progress bars"
- data-density-preference: "Multi-column dashboard showing all active projects, earnings, and pending invoices at once" vs "Single-column, distraction-free view focusing on the current billable task"
- visual-heritage: "Clean, white-space heavy layout with strict hierarchy and sans-serif typography" vs "High-contrast, bold-bordered containers with raw system fonts and unpolished aesthetic elements"


## CSS Leaks

(none)

## Recommendation

**GOOD** — CSS leaks are minimal.
**GOOD** — most axes are at the taste level.

## Implementation Notes

For `src/lib/server/context.ts` (session init):

1. Use this prompt with `Output.object({ schema: axisSchema })`
2. The word/image facade examples from each axis feed directly into scout prompts
3. As stages progress, scouts use the axis label + poles to generate stage-appropriate probes
4. The axis itself stays constant; only the facade concreteness changes
