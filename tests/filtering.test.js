const test = require('node:test');
const assert = require('node:assert/strict');
const { ElectronBlocker, Request } = require('@ghostery/adblocker-electron');
const { FALLBACK_FILTERS, resourceTypes, classifyBlocked, isDomain } = require('../src/filtering');

test('fallback rules compile into a usable filter engine', () => {
  const blocker = ElectronBlocker.parse(FALLBACK_FILTERS);
  assert.ok(blocker);
});

test('fallback rules block a known third-party ad request', () => {
  const blocker = ElectronBlocker.parse(FALLBACK_FILTERS);
  const request = Request.fromRawDetails({
    url: 'https://doubleclick.net/ads/pixel.gif',
    type: 'image',
    sourceUrl: 'https://example.com/'
  });
  assert.ok(blocker.match(request).match);
});

test('fallback rules do not block an ordinary page', () => {
  const blocker = ElectronBlocker.parse(FALLBACK_FILTERS);
  const request = Request.fromRawDetails({
    url: 'https://example.com/',
    type: 'main_frame'
  });
  assert.equal(Boolean(blocker.match(request).match), false);
});

test('request resource types translate to filter-list types', () => {
  assert.equal(resourceTypes.mainFrame, 'main_frame');
  assert.equal(resourceTypes.xhr, 'xmlhttprequest');
  assert.equal(resourceTypes.stylesheet, 'stylesheet');
});

test('blocked requests are categorized as ads or trackers', () => {
  assert.equal(classifyBlocked('https://pagead2.googlesyndication.com/pagead/js/ads.js').category, 'ad');
  assert.equal(classifyBlocked('https://www.google-analytics.com/g/collect').category, 'tracker');
});

test('host matching does not match lookalike domains', () => {
  assert.equal(isDomain('ads.doubleclick.net', 'doubleclick.net'), true);
  assert.equal(isDomain('notdoubleclick.net', 'doubleclick.net'), false);
});
