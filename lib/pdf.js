/**
 * Render a monthly report (markdown) to a shareable PDF (spec §8) using the
 * already-installed Playwright Chromium — no external service.
 */
const { marked } = require('marked');

async function reportToPdf({ org, generated_at, report }) {
  const { chromium } = require('playwright');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Inter,Arial,sans-serif;color:#1a1a1a;margin:48px;line-height:1.5}
    h1{color:#1A56DB;font-size:24px} h2,h3{color:#111;margin-top:24px}
    .meta{color:#666;font-size:12px;margin-bottom:24px}
    table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:6px 10px;font-size:13px}
    code{background:#f4f4f5;padding:1px 4px;border-radius:3px}
  </style></head><body>
    <h1>${org || 'Organisation'} — Monthly Report</h1>
    <div class="meta">Generated ${new Date(generated_at).toLocaleString()} · LeadPilot Ad Manager</div>
    ${marked.parse(report || '')}
  </body></html>`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } });
  } finally {
    await browser.close();
  }
}

module.exports = { reportToPdf };
