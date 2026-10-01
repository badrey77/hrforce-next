/**
 * The demo's only stylesheet, served at /assets/demo.css (kept in a module so `tsc` ships it without a copy step).
 * CSS logical properties only (inline-start/end), so the Arabic pages mirror with `dir="rtl"`. System fonts: no
 * external requests.
 */
export const DEMO_CSS = `
:root { color-scheme: light dark; --bg: #f5f6f8; --fg: #1d2330; --muted: #5b6474; --card: #fff; --line: #d9dde5;
  --accent: #0b5cad; --accent-fg: #fff; --notice: #fff6db; --notice-line: #e5c46b; --error: #fde8e8; --error-line: #d98080; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #14171d; --fg: #e8ebf1; --muted: #a3acbb; --card: #1d2129; --line: #353b47;
    --accent: #5ea3ec; --accent-fg: #0b1520; --notice: #3a3320; --notice-line: #8a7433; --error: #3d2020; --error-line: #a35656; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Tahoma, "Noto Sans Arabic", sans-serif; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 1rem;
  padding-block: .75rem; padding-inline: 1rem; border-block-end: 1px solid var(--line); background: var(--card); }
.product { color: var(--muted); font-size: .9rem; }
.lang { color: var(--accent); }
.card { max-inline-size: 40rem; margin-block: 2rem; margin-inline: auto; padding: 1.5rem;
  background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
@media (max-width: 480px) { .card { margin-block: 1rem; margin-inline: .5rem; padding: 1rem; } }
h1 { font-size: 1.5rem; margin-block: 0 1rem; }
h2 { font-size: 1.1rem; margin-block: 1.5rem .5rem; }
dl { margin: 0; }
dl div { display: flex; flex-wrap: wrap; gap: .25rem 1rem; padding-block: .35rem; border-block-end: 1px solid var(--line); }
dt { color: var(--muted); min-inline-size: 10rem; }
dd { margin: 0; font-weight: 600; }
.roles { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: .5rem; }
.roles li { padding-block: .25rem; padding-inline: .75rem; border-radius: 999px; background: var(--accent); color: var(--accent-fg); }
.notice { padding: .75rem 1rem; border: 1px solid var(--notice-line); background: var(--notice); border-radius: 6px; }
.notice.error { border-color: var(--error-line); background: var(--error); }
details { margin-block: 1.5rem; }
summary { cursor: pointer; color: var(--accent); }
pre { overflow-x: auto; padding: .75rem; background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
  font-size: .85rem; text-align: start; }
.button, button { display: inline-block; padding-block: .6rem; padding-inline: 1.2rem; border: 0; border-radius: 6px;
  background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
.button:focus-visible, button:focus-visible, a:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
`;
