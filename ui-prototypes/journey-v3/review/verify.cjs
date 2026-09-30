// Offline prototype verification; uses the workspace's existing Playwright.
const { chromium } = require('/Users/bozoegg/Desktop/LUMI-NEW/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const root = '/Users/bozoegg/Desktop/LUMI-NEW/ui-prototypes/journey-v3';
const screens = JSON.parse(fs.readFileSync(path.join(root, 'journey.json'), 'utf8'));
(async () => {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:1100}, colorScheme:'dark', reducedMotion:'reduce'});
  const failures = [];
  const captures = [];
  const assert = (condition, message) => { if (!condition) failures.push(message); };
  page.on('pageerror', error => failures.push(error.message));
  const url = 'file://' + root + '/index.html';
  const load = async id => {
    await page.goto(url + '#' + id);
    await page.locator('#screen-image').evaluate(image => image.decode());
  };
  const capture = async name => {
    await page.evaluate(() => window.scrollTo(0,0));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ': horizontal overflow');
    await page.screenshot({path:path.join(root,'review',name+'.png'),fullPage:true,animations:'disabled'});
    captures.push(name+'.png');
  };
  const checkLinks = async () => {
    const links = await page.locator('a[href]').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
    for (const link of links) {
      if (/^(https?:|#)/.test(link)) continue;
      assert(fs.existsSync(path.resolve(root, link.split('#')[0])), 'Missing local link: ' + link);
    }
  };
  await page.goto(url);
  assert(await page.locator('#screen-title').textContent() === 'Follow the agent’s work', 'Default must show revised active-work screen');
  for (const screen of screens) {
    await load(screen.id);
    assert(await page.locator('#count').textContent() === screen.n + ' / 13', screen.id + ': count');
    assert(await page.locator('.step[aria-current="step"]').count() === 1, screen.id + ': selected navigation');
    assert(await page.locator('#full-size').getAttribute('href') === screen.file, screen.id + ': asset link');
    assert(await page.locator('#prompt-link').getAttribute('href') === screen.prompt, screen.id + ': prompt link');
    await checkLinks();
    await page.locator('#primary').click();
    await page.waitForURL('**#' + screen.next);
    for (let i = 0; i < screen.hotspots.length; i++) {
      const spot = screen.hotspots[i];
      assert(spot.x >= 0 && spot.y >= 0 && spot.x + spot.w <= 100 && spot.y + spot.h <= 100, screen.id + ': hotspot bounds ' + spot.label);
      await load(screen.id);
      await page.locator('.hotspot').nth(i).click();
      if (spot.to.startsWith('@')) {
        assert(await page.locator('#simulation-dialog').isVisible(), screen.id + ': dialog ' + spot.label);
        await page.keyboard.press('Escape');
        assert(!await page.locator('#simulation-dialog').isVisible(), 'Escape should close ' + spot.label);
      } else await page.waitForURL('**#' + spot.to);
    }
  }
  await load('working');
  await page.locator('#toggle-hotspots').click();
  assert(await page.locator('#toggle-hotspots').getAttribute('aria-pressed') === 'true', 'Hotspot toggle');
  await page.locator('#toggle-hotspots').click();
  await page.locator('summary').click();
  for (const id of ['authFailed','identityOnly','noProjects','missingFolder']) {
    await page.locator('[data-dialog="' + id + '"]').click();
    assert(await page.locator('#simulation-dialog').isVisible(), id + ': recovery dialog');
    await page.keyboard.press('Escape');
    assert(await page.locator('[data-dialog="' + id + '"]').evaluate(node => node === document.activeElement), id + ': focus restoration');
  }
  await page.locator('summary').click();
  await capture('desktop-working');
  for (const id of ['symbols','approval','changes']) {
    await load(id);
    if (id === 'approval') assert(!(await page.locator('#primary').getAttribute('class') || '').includes('primary'), 'Approval must be neutral');
    await capture('desktop-' + id);
  }
  await page.setViewportSize({width:390,height:844});
  await load('working');
  await capture('mobile-working');
  await load('signin');
  await capture('mobile-signin');
  await page.goto(url + '#invalid');
  assert(await page.locator('#screen-title').textContent() === 'Launch', 'Unknown route fallback');
  await page.setViewportSize({width:1800,height:1100});
  await page.goto('file://' + root + '/storyboard.html');
  await page.locator('.story img').evaluateAll(async images => {
    for (const image of images) { image.loading = 'eager'; await image.decode(); }
  });
  assert(await page.locator('.story').count() === 13, 'Storyboard count');
  await checkLinks();
  await capture('storyboard');
  const report = {date:'2026-09-29', scope:'Generated-image gallery only; no native app or runtime validation', desktop:{width:1440,height:1100}, mobile:{width:390,height:844}, storyboard:{width:1800,height:1100}, screens:screens.length, hotspots:screens.reduce((sum,screen)=>sum+screen.hotspots.length,0), checked:['all image decodes','all primary routes','every hotspot route or dialog','four recovery dialogs','Escape and focus restoration','selected navigation','full-size and prompt links','all local links','neutral approval action','hotspot toggle','unknown route fallback','desktop and mobile overflow','page errors'], captures, failures};
  fs.writeFileSync(path.join(root,'review','verification.json'), JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  await browser.close();
  if (failures.length) process.exit(1);
})().catch(error => { console.error(error); process.exit(1); });
