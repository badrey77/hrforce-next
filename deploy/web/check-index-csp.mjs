// Fails when the built index.html needs something the staging CSP (deploy/Caddyfile) forbids:
// an inline <script> (no src) or an inline event-handler attribute (onload=…, onclick=…). Both are blocked by
// `script-src 'self'`. Angular's critical-CSS inlining ("inlineCritical", on by default in production) adds both
// (an onload-style script that swaps `media="print"` stylesheets), which would leave the app unstyled under the CSP;
// the production configuration in apps/web/angular.json must set optimization.styles.inlineCritical = false.
// Usage: node deploy/web/check-index-csp.mjs apps/web/dist/web/browser/index.html
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node check-index-csp.mjs <index.html>');
  process.exit(2);
}
const html = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const problems = [];
for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
  if (!/\ssrc\s*=/i.test(tag)) problems.push(`inline script: ${tag}`);
}
for (const [tag] of html.matchAll(/<[a-z][^>]*\son[a-z]+\s*=[^>]*>/gi)) {
  problems.push(`inline event handler: ${tag.slice(0, 120)}`);
}
if (problems.length > 0) {
  console.error(`${file} is not compatible with the staging CSP (script-src 'self'):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    'Fix: in apps/web/angular.json, production configuration: ' +
      '"optimization": {"scripts": true, "styles": {"minify": true, "inlineCritical": false}, "fonts": true}',
  );
  process.exit(1);
}
console.log(`${file}: no inline script or event handler (CSP script-src 'self' compatible)`);
