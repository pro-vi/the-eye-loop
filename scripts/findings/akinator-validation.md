# Akinator Validation — Raw Evidence Scout Pattern

Model: `gemini-3.1-flash-lite-preview`
Date: 2026-03-21
Runs per test: 3
Intent: "personal finance app that doesn't feel like a spreadsheet"

## Summary

| Hypothesis | Avg Score | Verdict |
|-----------|-----------|---------|
| H1: Scout next-probe from raw evidence | 6.0/6 | **PASS** |
| H2: Emergent concreteness progression | 2.7/3 | **PASS** |
| H3: Builder extraction from raw evidence | 6.0/6 | **PASS** |

## H1: Scout Next-Probe from Raw Evidence

### Round 1 (3 swipes) — Run 1 (6/6, 2365ms)
- **Probe:** "An abstract, fluid visualization of monthly spending represented as a topography map or a 'weather report' for budget health rather than traditional bar graphs or pie charts."
- **Hypothesis:** "Does the user prioritize an intuitive, abstract 'feeling' of their financial health over the ability to perform granular data analysis?"
- **Gap:** "The threshold between 'abstract/calm' aesthetics and 'functional utility' in personal finance."
- **If accepted:** "Confirms a preference for highly interpretative, non-numeric UI design, suggesting a 'calm tech' aesthetic."
- **If rejected:** "Indicates they still require enough structural grounding to feel in control of the finances, even if they dislike spreadsheets."
- **Avoids:** grid layouts, table-based data presentation, monospaced typography, clinical blue/white color palettes, strict hierarchical navigation
- PASS: avoidsRejected
- PASS: isNotRedundant
- PASS: hasRealHypothesis
- PASS: hasGap
- PASS: acknowledgesAntiPatterns
- PASS: hasNovelty

### Round 1 (3 swipes) — Run 2 (6/6, 2521ms)
- **Probe:** "A high-fidelity mockup of a personal finance interface that visualizes spending as a growing organic garden, where healthy habits make the garden bloom and debt or overspending causes specific plants to wilt, instead of using bar charts or lists."
- **Hypothesis:** "Does the user value emotional gamification and metaphorical data visualization, or are they looking for a more functional, albeit non-spreadsheet, interface?"
- **Gap:** "We know they dislike clinical/accounting vibes, but we don't know if they want a 'tool' that is highly functional but stylish, or a 'product' that completely reinvents the finance UX through metaphor."
- **If accepted:** "Confirms a preference for abstract, gamified, or 'magical' interfaces that prioritize emotional resonance over literal data representation."
- **If rejected:** "Confirms that while they hate spreadsheets, they still prioritize high-utility, functional interaction models over whimsical metaphors."
- **Avoids:** grids, tables, monospaced fonts, sterile white backgrounds, traditional progress bars, financial accounting terminology
- PASS: avoidsRejected
- PASS: isNotRedundant
- PASS: hasRealHypothesis
- PASS: hasGap
- PASS: acknowledgesAntiPatterns
- PASS: hasNovelty

### Round 1 (3 swipes) — Run 3 (6/6, 1870ms)
- **Probe:** "A visual interface that uses fluid, organic data-visualization (like glowing rings or tree-branch growth) to show progress toward financial goals, rather than static bar charts or pie graphs."
- **Hypothesis:** "Does the user prefer a metaphor-based, abstract representation of their finances, or do they still require a level of 'glanceable' numeric data that remains grounded in reality despite the warmth?"
- **Gap:** "We know they dislike 'spreadsheet-like' interfaces, but we don't know the limit of their desire for abstraction; we are testing if they value aesthetic whimsy over functional readability."
- **If accepted:** "Confirms the user wants a radical departure from traditional finance UI, favoring an emotional or gamified 'living' interface."
- **If rejected:** "Confirms the user wants a friendly 'companion' tone but still demands standard, interpretable data structures to feel secure in their financial oversight."
- **Avoids:** grid-based layouts, clinical sans-serif fonts, traditional accounting icons like calculators or paper ledgers, monochromatic professional color palettes
- PASS: avoidsRejected
- PASS: isNotRedundant
- PASS: hasRealHypothesis
- PASS: hasGap
- PASS: acknowledgesAntiPatterns
- PASS: hasNovelty

### Round 2 (8 swipes) — Run 1 (6/6, 2409ms)
- **Probe:** "A high-fidelity mockup of a personal finance 'habit-tracker' style feed that uses gamified progress rings and small, colorful badges to reward savings, contrasted with a navigation structure that mimics a journal or scrapbook timeline."
- **Hypothesis:** "Does the user interpret 'not a spreadsheet' as wanting active, gamified engagement with their money, or do they prefer a passive, contemplative, diary-like reflection of their spending habits?"
- **Gap:** "We know they dislike 'finance-y' aesthetics (spreadsheets, dark mode, neon) and like 'warm/organic' vibes, but we don't know the level of interactivity or 'game' elements they are comfortable with."
- **If accepted:** "Confirms a preference for 'active lifestyle' design where financial tracking is treated like a daily wellness or fitness habit."
- **If rejected:** "Indicates that while they dislike spreadsheets, they still view finance as a more serious, private, or 'slow' activity that shouldn't be gamified."
- **Avoids:** multi-column layouts, monospaced fonts, dark mode, clinical/cold aesthetics, extreme minimalism
- PASS: avoidsRejected
- PASS: isNotRedundant
- PASS: hasRealHypothesis
- PASS: hasGap
- PASS: acknowledgesAntiPatterns
- PASS: hasNovelty

### Round 2 (8 swipes) — Run 2 (6/6, 2382ms)
- **Probe:** "A high-fidelity mockup of a transaction history feed that uses playful, gamified status indicators (like progress bars or badges) to represent spending health versus a traditional list of categorized labels."
- **Hypothesis:** "Does the user prefer a 'game-like' progression system to motivate financial behavior, or does that lean too far into 'gimmick' territory compared to the 'artisanal/craft' feel they previously accepted?"
- **Gap:** "We know they dislike spreadsheets and tech-dashboards, but we don't know if they want a passive 'journal' aesthetic or an active 'coaching/game' aesthetic."
- **If accepted:** "Confirms that the user wants proactive engagement and feedback loops, even if they veer into gamification."
- **If rejected:** "Confirms that the user prefers a more passive, editorialized 'lifestyle' interface rather than an interactive game-like experience."
- **Avoids:** spreadsheets, monospaced fonts, glassmorphism, cold clinical grids, minimalist one-number displays
- PASS: avoidsRejected
- PASS: isNotRedundant
- PASS: hasRealHypothesis
- PASS: hasGap
- PASS: acknowledgesAntiPatterns
- PASS: hasNovelty

### Round 2 (8 swipes) — Run 3 (6/6, 2069ms)
- **Probe:** "A high-fidelity mockup of a 'financial story' feed: a vertical, scrollable layout similar to a social media story or a blog-style narrative, where individual daily spending habits are presented as short, conversational prose segments with integrated 'humanizing' vignettes rather than structured charts."
- **Hypothesis:** "Does the user prefer a narrative, time-based consumption of financial data, or do they still ultimately need a navigational structure to manage their money?"
- **Gap:** "We know they dislike structure, but we do not know if they are willing to sacrifice functional navigation for a purely narrative/story-based interaction model."
- **If accepted:** "Confirms the user wants a radical shift toward narrative-based UI that deprioritizes the 'dashboard' concept entirely in favor of an 'experience' concept."
- **If rejected:** "Suggests that while they dislike spreadsheets, they still require a traditional 'control center' or navigation architecture for functional finance."
- **Avoids:** grids, monospaced fonts, dense data presentation, neon glassmorphism, clinical precision
- PASS: avoidsRejected
- PASS: isNotRedundant
- PASS: hasRealHypothesis
- PASS: hasGap
- PASS: acknowledgesAntiPatterns
- PASS: hasNovelty

### Round 3 (13 swipes) — Run 1 (6/6, 2497ms)
- **Probe:** "A screen showing a 'Personal Finance Journal' layout where daily spending is presented as a collage of hand-written style notes, receipts, and small illustrations integrated directly into the transaction feed, rather than a structured list."
- **Hypothesis:** "I want to determine if the user's preference for 'conversational' and 'warm' aesthetics is specifically for a structured interaction (chat) or if they prefer a more abstract, journal-like manual entry experience."
- **Gap:** "The tension between 'automated finance utility' vs 'journaling/reflection habit'."
- **If accepted:** "Confirms the user values an artisanal, record-keeping aesthetic over automated, dashboard-driven intelligence."
- **If rejected:** "Suggests that while the user dislikes spreadsheets, they still require the cognitive clarity of structured categorization and automated data grouping."
- **Avoids:** Spreadsheet grids, Tabbed navigation, Gamified progress bars, Dark mode/Neon tech aesthetics
- PASS: avoidsRejected
- PASS: isNotRedundant
- PASS: hasRealHypothesis
- PASS: hasGap
- PASS: acknowledgesAntiPatterns
- PASS: hasNovelty

### Round 3 (13 swipes) — Run 2 (6/6, 1951ms)
- **Probe:** "A high-fidelity layout where transaction history appears as a series of tactile, physical-looking cards stacked like a deck of notes, requiring a swipe gesture to move through them, rather than a vertical scrolling list."
- **Hypothesis:** "Does the user prefer a tactile, physical object metaphor (deck of cards) over a standard digital interface pattern (scrolling list), even if the latter is more efficient?"
- **Gap:** "We have established the tone (warm/conversational) and the navigation (chat/cards), but we don't know if they prefer 'information as a stream' vs 'information as an object to be handled'."
- **If accepted:** "Confirms the user values 'delight' and physical-digital skeuomorphism over pure interface efficiency."
- **If rejected:** "Confirms that while they want a non-spreadsheet feel, they still prioritize the functional speed of list-based information retrieval."
- **Avoids:** spreadsheets, dense data grids, neon glassmorphism, traditional tabbed navigation, gamification
- PASS: avoidsRejected
- PASS: isNotRedundant
- PASS: hasRealHypothesis
- PASS: hasGap
- PASS: acknowledgesAntiPatterns
- PASS: hasNovelty

### Round 3 (13 swipes) — Run 3 (6/6, 1930ms)
- **Probe:** "A high-fidelity layout where financial insights are integrated into a 'journal-style' feed, featuring date-stamped entries with small, abstract polaroid-style photos for significant purchases, alongside handwritten-style annotations."
- **Hypothesis:** "Does the user value a 'memory-based' or 'life-log' approach to money management, where spending is contextualized through personal experience rather than categorical data points?"
- **Gap:** "We know they like conversational and warm interfaces, but we are unsure if they want the app to be a record of their life (journaling) or a tool for forward-looking financial discipline (planning)."
- **If accepted:** "Confirms the user wants a highly qualitative, personalized financial experience that leans into storytelling over data visualization."
- **If rejected:** "Confirms the user prefers a more structured, utility-focused interaction model, despite their dislike of traditional spreadsheets."
- **Avoids:** Spreadsheet-like grids, Clinical/Tech-forward aesthetics, Gamified progress bars, Dense dashboard navigation
- PASS: avoidsRejected
- PASS: isNotRedundant
- PASS: hasRealHypothesis
- PASS: hasGap
- PASS: acknowledgesAntiPatterns
- PASS: hasNovelty

## H2: Emergent Concreteness Progression

### Format Progression

| Round | Expected | Actual | Match Rate |
|-------|----------|--------|------------|
| 1 (3 swipes) | word | word, word, word | 100% |
| 2 (8 swipes) | word/image | mockup, mockup, mockup | 0% |
| 3 (13 swipes) | image/mockup | mockup, mockup, mockup | 100% |

### Round 1 (3 swipes — expect word) — Run 1
- **Format:** word
- **Reasoning:** "The previous rejections suggest a desire to move away from rigid, clinical systems, but 'Companion' was accepted, suggesting a need for nurture or growth. I need to test if the user prefers an interface based on biological growth metaphors (cultivation) rather than mechanical ones (accounting)."
- **Probe:** "Gardening or Greenhouse"
- PASS: matchesExpected
- PASS: contentMatchesFormat
- PASS: reasoningMentionsEvidence

### Round 1 (3 swipes — expect word) — Run 2
- **Format:** word
- **Reasoning:** "The user rejected 'Precision' and 'Ledger' but accepted 'Companion,' suggesting they want a metaphor for growth and cultivation rather than data entry. I need to test if they lean towards organic, nurturing imagery over mechanical or industrial financial metaphors."
- **Probe:** "Gardener"
- PASS: matchesExpected
- PASS: contentMatchesFormat
- PASS: reasoningMentionsEvidence

### Round 1 (3 swipes — expect word) — Run 3
- **Format:** word
- **Reasoning:** "The previous evidence indicates a strong rejection of clinical, rigid, or accounting-based visual languages. The term 'Organic Growth' tests whether the user prefers visual metaphors based on nature (e.g., plants, fluid shapes, growth) to visualize their financial health, rather than traditional bar charts or numerical tables."
- **Probe:** "Organic Growth"
- PASS: matchesExpected
- PASS: contentMatchesFormat
- PASS: reasoningMentionsEvidence

### Round 2 (8 swipes — expect image) — Run 1
- **Format:** mockup
- **Reasoning:** "We have established a clear preference for organic, warm, and non-spreadsheet aesthetics. I am now ready to test whether the user prefers abstract, emotive data visualization over traditional charts to maintain the 'non-spreadsheet' feel."
- **Probe:** "A mobile screen showing a 'spending health' summary where the balance is represented by a soft, fluid blob shape that ch"
- FAIL: matchesExpected
- PASS: contentMatchesFormat
- PASS: reasoningMentionsEvidence

### Round 2 (8 swipes — expect image) — Run 2
- **Format:** mockup
- **Reasoning:** "The evidence shows a consistent rejection of clinical, high-tech, or dense UI patterns, while showing preference for warmth, organic shapes, and artisanal/hand-crafted visual languages. A mockup allows me to test if this 'craft' aesthetic can effectively balance usability with the 'anti-spreadsheet' mandate."
- **Probe:** "A mobile screen showing a 'spending health' summary as a stack of soft, tactile cards that can be swiped away, using a w"
- FAIL: matchesExpected
- PASS: contentMatchesFormat
- PASS: reasoningMentionsEvidence

### Round 2 (8 swipes — expect image) — Run 3
- **Format:** mockup
- **Reasoning:** "The user has consistently rejected grid-based, dark mode, and clinical aesthetics while accepting conversational and organic visual motifs. A mockup allows us to test if they want to move beyond 'charts' entirely toward abstract data visualization."
- **Probe:** "A mobile screen showing a 'spending health' summary where monthly expenses are represented as flowing water levels in or"
- FAIL: matchesExpected
- PASS: contentMatchesFormat
- PASS: reasoningMentionsEvidence

### Round 3 (13 swipes — expect mockup) — Run 1
- **Format:** mockup
- **Reasoning:** "I have consistent evidence that the user prefers conversational, narrative-driven, and organic-feeling interfaces over traditional tabular or dashboard structures. A specific mockup allows me to test if they prefer abstract, non-numeric visual metaphors over conventional data visualization."
- **Probe:** "A mobile screen showing a single 'Daily Insight' card that uses a natural language summary—'You spent $12 less on coffee"
- PASS: matchesExpected
- PASS: contentMatchesFormat
- PASS: reasoningMentionsEvidence

### Round 3 (13 swipes — expect mockup) — Run 2
- **Format:** mockup
- **Reasoning:** "The user has consistently rejected traditional dashboard/tabbed structures (13) and dense layouts (5), while showing interest in conversational (12) and narrative (9) layouts. A vertical, feed-based UI bridges the gap between chat-like interaction and visual data summary without the rigidity of a grid."
- **Probe:** "A singular, scrollable feed interface where personal financial 'nuggets' (like 'You saved $50 this week' or 'Coffee spen"
- PASS: matchesExpected
- PASS: contentMatchesFormat
- PASS: reasoningMentionsEvidence

### Round 3 (13 swipes — expect mockup) — Run 3
- **Format:** mockup
- **Reasoning:** "The user has consistently rejected traditional dashboard/tabbed structures (evidence 13) and dense spreadsheets (evidence 5), while accepting conversational (evidence 12) and narrative/card-based layouts (evidence 9). I have sufficient evidence to test a specific 'feed' interaction model that replaces the dashboard entirely."
- **Probe:** "A mobile interface screen showing a 'Daily Financial Pulse' as a single, vertical scrollable feed. Instead of tabs, the "
- PASS: matchesExpected
- PASS: contentMatchesFormat
- PASS: reasoningMentionsEvidence

## H3: Builder Extraction from Raw Evidence

### Run 1 (6/6, 2800ms)
- **Can build:** Main Interface Shell (Use a warm cream background with rounded shapes and serif ty); Spending Summary Module (Implement a card-based layout displaying exactly 3 categorie); Interaction Model (Use a conversational chat-bubble interface for delivering sp)
- **Anti-patterns:** Dense multi-column spreadsheet grids; Monospaced typography; Dark mode with neon accents; Tabbed navigation with segmented views; Gamified full-screen growth animations
- **Blocking:** Transaction History: How should the transaction history be presented to avoid the rejected 'ledger' f
- **Probe brief:** "How should we structure the transaction history to maintain the 'companion' feel without becoming a 'ledger'?"
  - Component: Transaction History Feed
  - Option A: A conversational, chronological stream of cards that integrates with the chat interface.
  - Option B: A static, simplified list view grouped by category with monthly comparison bars.
- PASS: hasConcreteComponents
- PASS: isGrounded
- PASS: hasAntiPatterns
- PASS: hasSpecificBlocker
- PASS: briefIsGrounded
- PASS: avoidsAxisLanguage

### Run 2 (6/6, 3176ms)
- **Can build:** Main Interface Shell (Use a warm cream background with rounded shapes and serif ty); Spending Summary Module (Implement a card-based layout displaying exactly 3 categorie); Interaction Model (Use a conversational chat-bubble interface for delivering sp)
- **Anti-patterns:** Dense multi-column spreadsheet grids; Monospaced typography; Dark mode with neon accents; Tabbed navigation with segmented views; Gamified full-screen growth animations
- **Blocking:** Transaction History: How should the transaction history be presented to avoid the rejected 'ledger' f
- **Probe brief:** "How should we structure the transaction history to maintain the 'companion' feel without becoming a 'ledger'?"
  - Component: Transaction History Feed
  - Option A: A conversational, chronological stream of cards that integrates with the chat interface.
  - Option B: A static, simplified list view grouped by category with monthly comparison bars.
- PASS: hasConcreteComponents
- PASS: isGrounded
- PASS: hasAntiPatterns
- PASS: hasSpecificBlocker
- PASS: briefIsGrounded
- PASS: avoidsAxisLanguage

### Run 3 (6/6, 2541ms)
- **Can build:** Main Interface Shell (Use a warm cream background with rounded shapes and serif ty); Spending Summary Module (Implement a card-based layout displaying exactly 3 categorie); Interaction Model (Use a conversational chat-bubble interface for delivering sp)
- **Anti-patterns:** Dense multi-column spreadsheet grids; Monospaced typography; Dark mode with neon accents; Tabbed navigation with segmented views; Gamified full-screen growth animations
- **Blocking:** Transaction History: How should the transaction history be presented to avoid the rejected 'ledger' f
- **Probe brief:** "How should we structure the transaction history to maintain the 'companion' feel without becoming a 'ledger'?"
  - Component: Transaction History Feed
  - Option A: A conversational, chronological stream of cards that integrates with the chat interface.
  - Option B: A static, simplified list view grouped by category with monthly comparison bars.
- PASS: hasConcreteComponents
- PASS: isGrounded
- PASS: hasAntiPatterns
- PASS: hasSpecificBlocker
- PASS: briefIsGrounded
- PASS: avoidsAxisLanguage

## Implications

**H1 PASS:** Scouts can work with raw evidence — no structured Anima YAML needed. The evidence list IS the Anima.

**H2 PASS:** Concreteness emerges from information density. Stage transitions can be LLM-driven.

**H3 PASS:** Builder can extract construction decisions from raw evidence. Same evidence format works for scouts and builder.

### GO: Rewrite scout/builder prompts to use raw evidence. Drop axis seeding. Stage transitions become emergent with oracle as fallback guardrail.
