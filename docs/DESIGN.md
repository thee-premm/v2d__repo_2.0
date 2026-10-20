# Design system

## Direction

Vote2Dine is an operational tool that students, cooks and administrators trust with daily decisions. The identity is **the mess token** — the perforated meal coupon familiar from hostel messes — expressed with restraint:

- **Colour:** deep mess-hall green (`--brand #1e5a43`) for trust and action; turmeric (`--accent #d4851f`) as a sparing signature (logo "2", current-step markers, focus rings, the "will" in the sign-in headline); warm paper neutrals. No gradients except the diagonal "sample data" banner stripe.
- **Type:** IBM Plex Sans (400/500/600) for text; IBM Plex Mono for times, roll numbers, codes and model versions. Self-hosted via Fontsource (no third-party font requests).
- **Shape:** hairline borders instead of shadows; radii 3–6 px; shadows only on overlays (dialogs, toasts, tooltips).
- **Signature component:** the vote token — menu on the left, a dashed tear line with notches, the vote "stub" on the right (stacked on phones).

Tokens live in `v2d_Frontend/src/styles/tokens.css`; light and dark values are both designed (dark mode follows the system, or the user's choice under Account → Appearance).

## Semantic colour

| Meaning | Token | Notes |
|---|---|---|
| YES declaration | `--yes` (green) | always paired with the word "Yes" |
| NO declaration | `--no` (turmeric-clay) | chosen for colour-vision separation from green (validated ΔE 12.8) |
| No vote | `--unvoted` + diagonal hatch | hatch is the secondary encoding |
| Status | `--ok`, `--warn`, `--danger`, `--info` | never used for series; always with icon or label |
| Data kind | `.kind` tag | MEASURED / MANUAL / DERIVED solid; ESTIMATE dashed turmeric |

## Layouts per role

| Workspace | Layout |
|---|---|
| Sign-in / activation | Split: the operational loop and principle on a dark panel; the form on paper |
| Student | Light top bar + bottom tab bar on phones; vote tokens grouped by day; reading width ≤ 960 px |
| Supervisor | Dark rail with mess switcher and live counts; day view with a "Needs attention" column; meal detail with lifecycle stepper |
| Kitchen | Same rail, fewer items; large type for targets; checklist rows; forms sized for tablets |
| Admin | Same rail with institution context; dense tables; analytics with drill-down |

## Charts

Hand-written SVG (`components/charts.tsx`) following one spec: single axis, solid hairline grid, columns ≤ 24 px with 4 px rounded data ends, 2 px lines, ≥ 8 px markers with a surface ring, hover/focus tooltips, legend for ≥ 2 series. Series 2 uses hollow markers so identity never depends on colour (dark-mode pair sits in the CVD warning band, so this secondary encoding is required). Missing values render as a dotted "not recorded" mark, never a zero bar. Every chart has an adjacent table with the same numbers.

Validated palettes (dataviz validator): light `#1f7a57, #d4851f` (CVD ΔE 12.8; turmeric < 3:1 so values are always labelled), dark `#2a8c62, #c9781f` (CVD ΔE 7.3 → secondary encoding).

## Interaction and accessibility

- Every async action shows a busy state; mutations update the UI from the server's response (no unconfirmed optimistic state); errors show the server's message and request ID for 5xx.
- Destructive or consequential actions use confirmation dialogs; audited ones require a reason.
- Native `<dialog>` (focus trapping, Escape), visible focus ring (`--focus`), skip link, labelled landmarks, `aria-live` for the counter result and toasts, `aria-pressed` vote buttons, `role=meter` progress.
- `prefers-reduced-motion` disables animation; `forced-colors` adds borders to badges and buttons.
- No horizontal page scroll at 390 px (checked by the browser smoke test); wide tables scroll inside their container.
- Times are always shown in the institution timezone and say so on meal pages.
