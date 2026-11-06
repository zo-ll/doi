# Sample prompts for the system prompt

Run each prompt on an empty design and check the result. Use a cheap model:

```sh
bun scripts/try-provider.ts claude-code:claude-haiku-5-5 "<prompt>"
```

A result is acceptable when:

- `index.html` and `styles.css` exist, and the page has no scripts, `style` attributes or external URLs.
- Each meaningful element has a unique kebab-case `data-oid`.
- `styles.css` puts its tokens in custom properties on `:root`.
- The page has no horizontal scroll at 390 and 1440 px (slides are 1920 px wide on purpose).
- The screenshots look like a finished design, not a wireframe.

## Prompts

1. A landing page for a small coffee roastery, with a hero, three coffees and a footer.
2. A pricing page with three plans. The middle plan is the recommended one.
3. A login form for a project management app.
4. A settings page with a sidebar, a profile form and notification toggles.
5. A title slide and one content slide for a talk about web performance.

## Scope and flow prompts (system prompt v3)

6. A task app with sign in, task list and settings. Expected: no question, 3 or more linked pages.
7. Make me an app. Expected: an `ask` block and no file change.
8. A pricing card for one plan. Expected: no question, one page.
9. A mobile app: a habit tracker with onboarding, a today view and stats. Expected: no question, 3 or more screens.

Results, `opencode-go:deepseek-v4.1-flash`, 2026-11-06, last pass: 6 gave 3 linked pages, 7 gave a card, 8 gave one page, 9 gave 4 screens. An earlier pass with a prompt without the "own tool call" rule lost files in 6 and 9.

## Results

System prompt v0, `claude-code:claude-haiku-5-5`, 2026-10-12. All five are acceptable.

| # | data-oid | Rule checks | Horizontal scroll | Tokens in / out / cached | Notes |
|---|---|---|---|---|---|
| 1 | 71 | pass | none | 24739 / 10839 / 9251 | Hero with an SVG bean, three cards, dark footer |
| 2 | 39 | pass | none | 25956 / 3908 / 16931 | Middle plan marked "Recommended", one primary button |
| 3 | 25 | pass | none | 20050 / 5825 / 9230 | Labels on all inputs, single sign-on as a second action |
| 4 | 75 | pass | none | 24409 / 10133 / 9244 | Tabs wrap at 390 px; toggles with labels |
| 5 | 22 | pass | 1920 px slides | 18126 / 3872 / 9239 | Two 1920 by 1080 sections, large type |
