# Desktop verification - ORACURA_Module1_PBIP.zip

Power BI Desktop is Windows-only, so this checklist must be run by hand. Work top to
bottom; each section has a **Pass** criterion and a **If it fails** pointer. Screenshot
any failure and paste it back - most PBIR fixes are one-line changes.

Time: ~15 minutes. You need: the zip, Power BI Desktop (any recent build), and this file.

## 0 · Install traps

1. Unzip `ORACURA_Module1_PBIP.zip` **fully** (opening the `.pbip` from inside the zip
   breaks the relative `../ORACURA.SemanticModel` reference).
2. Double-click `oracura/ORACURA.pbip`.

**Pass:** the report opens with 12 page tabs (00 Cover, 01 Findings, 00 Overview,
02 Executive, 03 Who bought what, 04 Usage & retention, 05 Experience & satisfaction,
06 Recommendation & voice, 07 Voice of customer, 08 Where to act, 09 Journey & heat,
10 Family deep-dive).

**If it fails:** "couldn't find dataset" → you opened it from inside the zip. "Invalid
report package" → note the error text and screenshot it; the package was validated
programmatically, so a Desktop-only complaint is new information.

## 1 · First-use banners

**Pass:** at most two benign banners ("calculated objects need to be manually
refreshed" / "Some of the tables have incomplete or no data"). Both are about the
embedded TMDL refresh state, not missing data - the rows are in the package.

**If it fails:** any banner naming a *visual* (e.g. "this visual couldn't be loaded")
→ screenshot that page; the visual type is the suspect, and the fix is in the builder
(anything schema-validated can still hit a Desktop-only guard).

## 2 · Visual census (no blanks, no red boxes)

Every page, in order. You must see real numbers/charts on every visual:

| Page | Must see |
|---|---|
| 00 Cover | ORACURA wordmark, 4 metadata tiles, 3 KPI tiles, dark footer nav |
| 01 Findings | 5 numbered claims with right-hand metrics |
| 00 Overview | 4 slicers, 3 KPI cards + 3 gauge arcs, dark journey hero with funnel, donut, combo (columns + NPS line by family), area chart, family scoreboard |
| 02 Executive | 4 cards, family bars, satisfaction donut, NPS pie, analyst read |
| 03 Who bought what | 4 slicers, city bars, age line, reason donut, when-purchased area |
| 04 Usage & retention | 4 cards, frequency area, change bars, situation column, household pie, narrative |
| 05 Experience & satisfaction | 4 cards, family column chart, stacked expectation columns, scoreboard table |
| 06 Recommendation & voice | 4 cards, like column chart, improve treemap, escalation list, evaluation detail |
| 07 Voice of customer | 3 cards, two verbatim tables (low-score + high-score) |
| 08 Where to act | 4 cards, heat grid, KPI (drivers), waterfall, narrative, drillthrough button |
| 09 Journey & heat | 4 cards, funnel, scatter, treemap, age line, narrative |
| 10 Family deep-dive | 4 cards, theme bars, city bars, casework queue - **showing all data** (the drillthrough filter only applies when you arrive via drillthrough) |

**If any visual is blank or red:** note its page + approximate position; the HTML
render in `oracura-render/shots/` is the expected shape, so "blank vs the render"
tells me whether it's data or structure.

## 3 · Navigation

1. From the Cover, click INDEX → 00 Overview (button text visible: "OVERVIEW ›").
2. Click the top pills: OVERVIEW / FINDINGS / EXECUTIVE / JOURNEY - each must work.
3. Walk the footer chain forward 02 → 03 → … → 09, then INDEX on 09 back to the Cover.
4. Backward buttons (‹ FINDINGS etc.) must work on every page.

**Pass:** every button shows readable text and lands on the right page.

**If it fails:** buttons blank → the `fontFamily` quoting fix regressed (unlikely);
wrong page → the navigationSection GUID drifted (validator checks this, so report which
page/button).

## 4 · The two AI-visual tests (new in this build)

### 4a · Key Drivers (page 08, right column)

**Pass:** the visual renders a ranked list of drivers (teal/red bars) headed by
something like "top factors that increase/decrease NPS".

**If it fails (most likely):** the visual is empty with "Add data fields to see
influencers" - the role names `Analyze` / `ExplainBy` didn't bind. Fixes in order:
1. Click the visual → check the fields pane shows `Analyze = NPS` and `Explain by =
   Family, Improve theme` (read me the names you see).
2. If the wells are empty, the role keys are wrong - nothing in the JSON can guess
   them; I'll rename from your screenshot.

### 4b · Heat map conditional formatting (page 08, left column)

**Pass:** cells are shaded cream→deep orange with numbers 0/1/2 visible; Flosser
"L eakage" and "Service" cells are the darkest 2s.

**If it fails:** all cells white/plain (no gradient) → the FillRule didn't bind; cell
*values* should still show, so the matrix itself is fine and only the CF entry is
suspect. If cells are empty → the Rows/Columns/Values binding is the suspect.

Before this section, run the automated check (no Desktop needed):

```bash
node scripts/verify-drillthrough.mjs
```

It must print `all drillthrough bindings verified`: page 10 carries `type:
Drillthrough` + matching `filterConfig` (howCreated Drillthrough) + `pageBinding`,
the button on page 08 targets it, and a visual on page 08 projects `Family` so the
button can enable. If it prints failures, stop - fix those first.

## 5 · Drillthrough end-to-end

1. On page 08, click one cell/row in the heat grid (e.g. the Flosser row).
2. The **FAMILY DEEP-DIVE** button (bottom right) should now be *enabled*
   (it is inert without a Family selection - that's by design).
3. Click it: you land on page 10 with all cards/charts/queue filtered to that family.
4. Right-click any family data point on page 05 (column chart) → "Drill through" →
   the same page opens, filtered.
5. Click the **BACK** button (bottom right of page 10) to return.

**If it fails:**
- Button never enables → the heat grid selection isn't carrying Family (note what you
  selected; selection of a single cell should suffice).
- Landing on page 10 but unfiltered → the `pageBinding`/`howCreated` pair didn't
  register (screenshot the filter pane - it should show a "Drill through" filter group
  with Family).
- Right-click menu missing the page → Desktop doesn't consider it a drillthrough
  page; the `type: 'Drillthrough'` key or the binding shape is the suspect.

## 6 · Slicer behaviour (one pass)

1. On 00 Overview, pick Family = Flosser.
2. Every card/gauge/chart on the page must recut (NPS, top-2, daily use, combo, area,
   scoreboard). None may go blank.
3. Repeat one check on 03 (City = Chennai) and on the drillthrough page 10
   (the page-level slicers stack on top of the drillthrough filter).

**If a visual goes blank:** it lost its filter path - this is the single-dimension-path
hazard the model is designed to avoid, so report the page + visual + slicer value.

## 7 · Numbers sanity (30 seconds, compare to the cover)

- 204 respondents · 220 evaluations · avg satisfaction 4.15 · top-2 88.2% ·
  avg recommend 8.35 · NPS +44 · better than expected 59.5% · daily 52.7% ·
  still using 90.9% · detractors 21 · promoters 117 · service mentions 11.

(The client deck quotes NPS +6 - the workbook computes +44. That's the known
transcription divergence, not a bug.)

## 8 · Save-as + Fabric (optional)

- File → Save as → Power BI Desktop (.pbix). A .pbix cannot be authored outside
  Desktop; this step is the only sanctioned way to produce one.
- Then: Publish to Fabric, and/or zip the `oracura/` folder for the delivery pack.

## Report back

Paste: (a) any page that failed §2 with a screenshot, (b) §4a/4b verdicts, (c) §5
verdict, (d) anything else that looked wrong. The HTML contact sheet
(`oracura-render/contact-sheet.png`) is the visual reference for what "right" looks
like before Desktop's own rendering.
