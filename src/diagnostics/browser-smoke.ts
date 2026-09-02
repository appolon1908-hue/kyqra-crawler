import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.setContent('<main id="kyqra-browser-smoke">ready</main>');
  const value = await page.textContent('#kyqra-browser-smoke');
  if (value !== 'ready') throw new Error('browser_smoke_content_mismatch');
  console.log('KYQRA_BROWSER_ENGINE_SMOKE=PASS');
} finally {
  await browser.close();
}
