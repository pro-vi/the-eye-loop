// ── Shared prompt constants ──────────────────────────────────────────
// Used by both scout (mockup rendering) and builder (draft generation).
// Derived from v0, Lovable, Same.dev, Bolt research.

export const HTML_QUALITY_RULES = `HTML QUALITY RULES (apply to ALL html output):
1. Start with a <style> block defining CSS variables derived from evidence:
   :root { --bg: #FFF8F0; --card: #FFF; --accent: #FF8C69; --text: #4A3E38; --muted: #A1887F; --radius: 16px; --space: 20px; }
   Adjust these colors based on accepted evidence. NEVER use defaults blindly.
2. NEVER use blue (#0066CC, #2196F3, indigo) or purple unless evidence explicitly demands it.
   Blue/indigo is the universal marker of "AI-generated default."
3. NEVER leave placeholder comments, TODO sections, or "rest remains the same."
   Every section must have real content — text, numbers, labels.
4. ALWAYS ensure text contrast — no light text on light backgrounds.
5. Use flex/grid for layout. No absolute positioning unless intentional.
6. No emojis in UI text. Use text labels for icons ("Menu", "Back", not icons).
7. No external resources — no Google Fonts, no CDN links, no <img src="http...">.
   For placeholder images: <div style="background:linear-gradient(135deg, var(--accent), var(--bg)); height:200px; border-radius:var(--radius)"></div>
8. Every element needs INTENTIONAL styling — specific border-radius, padding, font-size.
   No unstyled defaults. No browser-default buttons, inputs, or links.
9. Mobile-first: width 100%, max-width 375px, no horizontal overflow.
10. Typography: pick ONE font family (serif or sans-serif) and use a consistent scale (14/16/20/28px).`;
