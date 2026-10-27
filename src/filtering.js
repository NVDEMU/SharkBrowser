const FALLBACK_FILTERS = [
  '||doubleclick.net^',
  '||googlesyndication.com^',
  '||googleadservices.com^',
  '||adnxs.com^',
  '||taboola.com^',
  '||outbrain.com^',
  '||criteo.com^',
  '||google-analytics.com^$third-party',
  '||googletagmanager.com^$third-party',
  '||connect.facebook.net^$third-party',
  '||hotjar.com^$third-party',
  '||mixpanel.com^$third-party',
  '||scorecardresearch.com^$third-party'
].join('\n');

const resourceTypes = {
  mainFrame: 'main_frame', subFrame: 'sub_frame', stylesheet: 'stylesheet',
  script: 'script', image: 'image', font: 'font', object: 'object',
  xhr: 'xmlhttprequest', ping: 'ping', media: 'media', websocket: 'websocket',
  other: 'other'
};

function isDomain(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

function classifyBlocked(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return { category: 'tracker', domain: 'unknown' }; }
  const host = parsed.hostname.toLowerCase();
  const adDomains = ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adnxs.com', 'adsrvr.org', 'adform.net', 'taboola.com', 'outbrain.com', 'criteo.com'];
  const trackerDomains = ['google-analytics.com', 'googletagmanager.com', 'hotjar.com', 'mixpanel.com', 'segment.com', 'segment.io', 'amplitude.com', 'scorecardresearch.com', 'quantserve.com', 'clarity.ms', 'bat.bing.com', 'connect.facebook.net'];
  if (adDomains.some(domain => isDomain(host, domain)) || /\/(ads?|advert|banner)([/?._-]|$)/i.test(parsed.pathname)) return { category: 'ad', domain: host };
  if (trackerDomains.some(domain => isDomain(host, domain)) || /(analytics|tracking|tracker|telemetry|pixel|beacon)/i.test(host + parsed.pathname)) return { category: 'tracker', domain: host };
  return { category: 'ad', domain: host };
}

module.exports = { FALLBACK_FILTERS, resourceTypes, classifyBlocked, isDomain };
