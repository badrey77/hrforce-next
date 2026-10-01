import { describe, expect, it } from 'vitest';
import { escapeHtml, html } from './html.js';

describe('html template helper', () => {
  it('escapes every interpolated value', () => {
    const name = `<script>alert("x")</script>' & \``;
    expect(html`<p>${name}</p>`.value).toBe('<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39; &amp; &#96;</p>');
  });

  it('escapes attribute values', () => {
    expect(html`<a href="${'"><img src=x onerror=1>'}">`.value).toBe('<a href="&quot;&gt;&lt;img src=x onerror=1&gt;">');
  });

  it('keeps nested html as is, joins arrays, skips null/undefined/false', () => {
    const items = ['a<b', 'c'].map((x) => html`<li>${x}</li>`);
    expect(html`<ul>${items}</ul>${null}${undefined}${false}${0}`.value).toBe('<ul><li>a&lt;b</li><li>c</li></ul>0');
  });

  it('escapeHtml leaves plain text untouched', () => {
    expect(escapeHtml('Agence Annaba — وكالة عنابة')).toBe('Agence Annaba — وكالة عنابة');
  });
});
