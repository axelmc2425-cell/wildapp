# Stats page sections (7b): organise the Stats page into tabs

Date: 2026-11-14. Status: approved by the owner's "build the rest" (short design; calls below are the controller's).

## Intent
After 7a the Stats page for Day, Week, Month and Year is one long scroll of about ten sections. The owner asked for it to be organised.

## Design (small change)
- The summary cards and the "Show as table" toggle stay at the top of the Day, Week, Month and Year views.
- Under them a tab row (`role="tablist"`) with four tabs, one shown at a time:
  - **Overview:** Daily totals, Year at a glance (Year only), Average by weekday chart.
  - **Apps & sites:** Top apps, Top sites (with Other browsing).
  - **Hours:** Hours of the day (bars, heatmap).
  - **Averages:** Averages and "Apps by average per active day".
- The chosen tab is remembered while the owner switches period, range or table mode, and resets to Overview when the page is reopened. It is part of the render signature, so a change re-renders.
- Keyboard: tabs are buttons with `aria-selected`, `role="tab"`, roving focus with Left/Right/Home/End, panel `role="tabpanel"` labelled by its tab. `data-fk="sec-overview|sec-apps|sec-hours|sec-averages"`.
- The Today view (timeline) and the drill-down keep their own layouts and are not tabbed. Opening a drill-down from Apps & sites and pressing Back returns to the Apps & sites tab.
- A tab whose content is empty still shows its own message (for example the hour placeholder); tabs are never hidden.
- At phone width the tab row scrolls horizontally if needed; no content change.

## Non-goals
No change to numbers, charts or the helper. No new data requests.

## Testing
Page tests: default tab Overview shows only its sections; each tab shows exactly its sections and hides the others; tab persists across period change; Back from drill-down restores the tab; keyboard navigation; table mode still works per tab; no section lost (union of tabs equals the previous page).
