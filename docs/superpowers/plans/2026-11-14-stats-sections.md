# Stats page sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan.

**Goal:** Split the Day/Week/Month/Year Stats view into four tabs (Overview, Apps & sites, Hours, Averages) under the summary cards.

**Architecture:** `dataView` in `src/modules/focus/ui/stats-page.js` builds the existing section nodes into four panels and renders only the selected one; a small tab bar is added; the chosen tab joins the render signature.

**Tech Stack:** vanilla JS ES modules, existing `h` helper, node tests with the fake DOM.

**Spec:** `docs/superpowers/specs/2026-11-14-stats-sections-design.md`

## Global Constraints
- No change to any number, chart builder or helper request. Existing tests keep passing except where they assume all sections are on one page (update those to select the right tab).
- Tab ids: `overview`, `apps`, `hours`, `averages`; `data-fk` `sec-<id>`. Default `overview`; kept across period/range/table changes; reset on page mount.
- Accessible tablist as in the spec. Light/dark via existing CSS variables; phone width scrolls the tab row.

## Review Focus
- Each existing section appears in exactly one tab (none lost, none duplicated): pinned by a union test.
- Back from a drill-down opened on Apps & sites returns to that tab.
- Empty periods (no usage) still show the existing empty note and no tabs.

---

### Task 1: Tabs in the Stats page

**Files:**
- Modify: `src/modules/focus/ui/stats-page.js`, `src/styles.css`
- Test: `tests/focus-stats-page.test.js`

**Interfaces:**
- Consumes: existing `dataView(entry)`, `section(title, ...kids)`, `hoursSection`, `averagesSection`, `card`, signature/render logic.
- Produces: `let sect = 'overview'` page state (in signature); `tabBar()` returning the tablist node; `dataView` returns cards + table toggle + tabBar + the selected panel (`<div role="tabpanel" id="fr-panel-<id>" aria-labelledby="fr-tab-<id>">`).

- [ ] **Step 1: Write failing tests** in `tests/focus-stats-page.test.js`: (a) default shows Overview sections only ("Daily totals" present, "Top apps"/"Hours of the day"/"Averages" absent); (b) clicking `sec-apps` shows Top apps and Top sites only; `sec-hours` shows Hours of the day only; `sec-averages` shows Averages and the apps-by-average list only; (c) the selected tab survives switching Week to Month and toggling table mode; (d) union of the four tabs' section headings equals the pre-change set (Daily totals, Year at a glance on Year, Average by weekday, Top apps, Top sites, Hours of the day, Averages); (e) drill-down opened from `app-<name>` on Apps & sites, Back returns with `sec-apps` selected; (f) ArrowRight/ArrowLeft/Home/End move selection and focus with `aria-selected`/roving `tabindex`; (g) an empty period shows the empty note and no tablist. Update existing tests that assume one long page.
- [ ] **Step 2: Run** `node --test tests/focus-stats-page.test.js`; expect FAIL.
- [ ] **Step 3: Implement** the tab bar and panel split in `dataView`; add `sect` to `signature()`; ArrowKey handling; reset `sect='overview'` only in `mountStatsPage` start. CSS: `.fr-tabs` (flex, gap, overflow-x auto, border-bottom) and `.fr-tab` / `.fr-tab[aria-selected="true"]` using existing variables.
- [ ] **Step 4: Run** `npm test`; expect PASS (all files).
- [ ] **Step 5: Commit** `feat(focus): Stats page sections as tabs`.
