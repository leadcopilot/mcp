/**
 * Playwright Website Scraper
 *
 * Used for:
 * 1. Organisation auto-enrichment — scrape client's own website when they onboard
 * 2. Competitor Intelligence — visit competitor websites and extract pricing/offers
 *
 * Completely free. Runs locally. No API key needed.
 * In production: runs as a microservice on Railway.
 */

const { assertPublicUrl } = require('../ssrf');

let chromium;

async function getBrowser() {
  if (!chromium) {
    const playwright = require('playwright');
    chromium = playwright.chromium;
  }
  return chromium;
}

async function scrapeWebsite(url, extract = 'all') {
  let browser;
  try {
    // SSRF guard — reject internal/private targets before we ever navigate.
    await assertPublicUrl(url);

    console.log(`[playwright] scraping ${url} (extract: ${extract})`);

    const pw = await getBrowser();
    browser = await pw.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();

    // Block images, fonts, and media for speed
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,mp4,mp3}', route => route.abort());

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Extract based on what is needed
    const data = await page.evaluate((mode) => {
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.textContent.trim() : null;
      };

      const getAllText = (selector) => {
        return Array.from(document.querySelectorAll(selector))
          .map(el => el.textContent.trim())
          .filter(t => t.length > 0);
      };

      const result = {
        title: document.title,
        url: window.location.href,
        meta_description: document.querySelector('meta[name="description"]')?.content || null,
      };

      if (mode === 'all' || mode === 'services') {
        // Try to extract services from headings and list items
        result.headings = getAllText('h1, h2, h3').slice(0, 20);
        result.paragraphs = getAllText('p').slice(0, 15).filter(p => p.length > 30);
      }

      if (mode === 'all' || mode === 'pricing') {
        // Look for pricing-related content
        const bodyText = document.body.innerText;
        const priceMatches = bodyText.match(/₹[\d,]+[\s\-–]*[\d,]*/g) ||
                             bodyText.match(/Rs\.?\s*[\d,]+/g) ||
                             bodyText.match(/INR\s*[\d,]+/g) || [];
        result.prices_found = [...new Set(priceMatches)].slice(0, 20);

        // Pricing sections by keyword
        const allText = getAllText('*');
        result.pricing_context = allText
          .filter(t => /price|pricing|cost|fee|rate|₹|Rs\.|INR/i.test(t))
          .slice(0, 10);
      }

      if (mode === 'all' || mode === 'contact') {
        const bodyText = document.body.innerText;
        const phones = bodyText.match(/(\+91[\s-]?)?[6-9]\d{9}/g) || [];
        const emails = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
        result.phones = [...new Set(phones)].slice(0, 5);
        result.emails = [...new Set(emails)].slice(0, 5);
      }

      if (mode === 'all') {
        // Full page text for AI analysis
        result.full_text = document.body.innerText.substring(0, 5000);
      }

      return result;
    }, extract);

    console.log(`[playwright] scraped ${url} successfully`);
    return { success: true, ...data };
  } catch (err) {
    console.error(`[playwright] failed to scrape ${url}:`, err.message);
    return { success: false, url, error: err.message };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Enrich an organisation profile by scraping their website
async function enrichOrganisation(websiteUrl) {
  const scraped = await scrapeWebsite(websiteUrl, 'all');
  if (!scraped.success) return scraped;

  return {
    success: true,
    website: websiteUrl,
    business_name: scraped.title?.replace(/[-|].*$/, '').trim(),
    meta_description: scraped.meta_description,
    headings: scraped.headings,
    services_mentioned: scraped.headings?.filter(h => h.length > 3 && h.length < 100) || [],
    prices_found: scraped.prices_found || [],
    contact: {
      phones: scraped.phones || [],
      emails: scraped.emails || [],
    },
    summary_text: scraped.full_text?.substring(0, 2000),
  };
}

module.exports = { scrapeWebsite, enrichOrganisation };
