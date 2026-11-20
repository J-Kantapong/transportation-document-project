// iPhone/iPad (Safari, LINE in-app browser) auto-detect numbers in a page - tax ID, phone, bank account, dates -
// and turn them into blue underlined links. On a document page that ends up in the screen view, the print and the
// PDF (html2canvas draws what Safari shows), so the tax invoice no longer looks like the real one (user 2026-11-20).
// Every document HTML puts this right after <meta charset>: the meta turns the detection off, the CSS paints any link
// iOS still adds (data detectors) like plain text.
export const NO_AUTO_LINK_HEAD =
  '<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">' +
  "<style>a[x-apple-data-detectors],a[href^=\"tel:\"],a[href^=\"sms:\"],a[href^=\"mailto:\"]{color:inherit!important;" +
  "text-decoration:none!important;font:inherit!important;pointer-events:none}</style>";

/** Adds NO_AUTO_LINK_HEAD to a full HTML document that does not have it yet (safety net for the PDF/iframe). */
export function withNoAutoLink(html: string): string {
  if (html.includes('name="format-detection"')) return html;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + NO_AUTO_LINK_HEAD);
  return NO_AUTO_LINK_HEAD + html;
}
