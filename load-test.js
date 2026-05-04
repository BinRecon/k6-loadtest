import http from 'k6/http';
import { sleep, check } from 'k6';
import { parseHTML } from 'k6/html';
import { Trend, Counter } from 'k6/metrics';

/*
  Configuration (env overrides)
  Example:
    k6 run -e BASE_URL=https://example.com -e REPETITIONS=10 -e DELAY_SECONDS=30 -e VUS=20 -e DURATION=60m load.js
*/
const BASE_URL = __ENV.BASE_URL || 'https://example.com';
const REPETITIONS = Number(__ENV.REPETITIONS || 10);
const DELAY_SECONDS = Number(__ENV.DELAY_SECONDS || 30);
const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || '30m';

export const options = {
  vus: VUS,
  duration: DURATION,
  // Add thresholds or outputs here if desired
};

/* Small list of user agents to randomize requests */
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/* Normalize relative URLs to absolute */
function normalizeUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch (e) {
    return null;
  }
}

/* Same-origin filter */
function isSameOrigin(urlA, urlB) {
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
  } catch (e) {
    return false;
  }
}

/* Crawl base URL and extract same-origin links */
function crawlLinks(baseUrl) {
  const links = new Set();
  const res = http.get(baseUrl, { headers: { 'User-Agent': getRandomUserAgent() }, timeout: '60s' });

  if (!res || res.status === 0) {
    console.warn(`Crawl failed for ${baseUrl} status=${res ? res.status : 'no-res'}`);
    return [baseUrl];
  }

  try {
    const doc = parseHTML(res.body);
    const anchors = doc.find('a');
    for (let i = 0; i < anchors.length; i++) {
      const href = anchors.get(i).attr('href');
      if (!href) continue;
      const abs = normalizeUrl(href, baseUrl);
      if (!abs) continue;
      if (abs.startsWith('mailto:') || abs.startsWith('tel:') || abs.startsWith('javascript:')) continue;
      if (!isSameOrigin(abs, baseUrl)) continue;
      const u = new URL(abs);
      u.hash = '';
      links.add(u.toString());
    }
  } catch (e) {
    // ignore parse errors
  }

  // Fallback regex scan for hrefs
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(res.body)) !== null) {
    const candidate = match[1];
    const abs = normalizeUrl(candidate, baseUrl);
    if (!abs) continue;
    if (abs.startsWith('mailto:') || abs.startsWith('tel:') || abs.startsWith('javascript:')) continue;
    if (!isSameOrigin(abs, baseUrl)) continue;
    const u = new URL(abs);
    u.hash = '';
    links.add(u.toString());
  }

  const arr = Array.from(links);
  if (arr.length === 0) return [baseUrl];
  return arr;
}

/* Helper: sanitize a URL into a metric-friendly name */
function sanitizeForMetric(url) {
  // remove protocol and replace non-alphanum with underscore
  try {
    const u = new URL(url);
    const path = (u.hostname + u.pathname).replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
    // limit length
    return path.substring(0, 200);
  } catch (e) {
    return 'unknown_link';
  }
}

/* Global map to hold per-link metric objects (created lazily) */
const metricsMap = {};

/* Create or return metrics for a link */
function getMetricsForLink(url) {
  const key = sanitizeForMetric(url);
  if (!metricsMap[key]) {
    // create metrics: Trend for response time, Counter for requests, Counter for failures
    metricsMap[key] = {
      rt: new Trend(`rt_${key}`, true),           // response time trend (ms)
      reqs: new Counter(`reqs_${key}`),           // total requests
      fails: new Counter(`fails_${key}`),         // failed requests
    };
  }
  return metricsMap[key];
}

/* Split links into contiguous chunks for VU assignment and ensure each VU has at least one link */
function chunkLinks(allLinks, totalVUs) {
  const chunks = Array.from({ length: totalVUs }, () => []);
  for (let i = 0; i < allLinks.length; i++) {
    const idx = i % totalVUs;
    chunks[idx].push(allLinks[i]);
  }
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].length === 0) chunks[i].push(BASE_URL);
  }
  return chunks;
}

/* Setup: crawl once and return discovered links */
export function setup() {
  console.log(`Crawling base URL: ${BASE_URL}`);
  const links = crawlLinks(BASE_URL);
  console.log(`Crawl complete. ${links.length} unique links discovered.`);
  links.slice(0, 20).forEach((l, idx) => console.log(`Link[${idx}]: ${l}`));
  return { links };
}

/* Default: each VU performs all repetitions for its assigned links, records per-link metrics */
export default function (data) {
  const allLinks = data.links || [BASE_URL];
  const vuId = __VU; // 1-based
  const totalVUs = options.vus || VUS;

  // Stagger start slightly
  sleep(Math.random() * 3);

  const chunks = chunkLinks(allLinks, totalVUs);
  const myLinks = chunks[vuId - 1] || [BASE_URL];

  console.log(`VU ${vuId} assigned ${myLinks.length} links.`);

  for (let i = 0; i < myLinks.length; i++) {
    const url = myLinks[i];
    const metrics = getMetricsForLink(url);

    for (let r = 0; r < REPETITIONS; r++) {
      const headers = {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      };

      let res;
      try {
        res = http.get(url, { headers, timeout: '60s' });
      } catch (err) {
        // network-level exception
        console.error(`VU ${vuId} EXCEPTION ${url} attempt ${r + 1}/${REPETITIONS}: ${err}`);
        metrics.reqs.add(1);
        metrics.fails.add(1);
        // Sleep before next attempt
        sleep(DELAY_SECONDS);
        continue;
      }

      const status = res && typeof res.status !== 'undefined' ? res.status : 0;
      const duration = res && res.timings && res.timings.duration ? res.timings.duration : 0;
      const errMsg = res && res.error ? res.error : '';

      // Record metrics
      metrics.reqs.add(1);
      if (status >= 200 && status < 400) {
        metrics.rt.add(duration);
      } else {
        metrics.fails.add(1);
        // still record response time if available
        if (duration > 0) metrics.rt.add(duration);
      }

      // Console log for immediate visibility
      if (status === 0) {
        console.error(`VU ${vuId} | attempt ${r + 1}/${REPETITIONS} | status 0 | ${url} | ${duration} ms | error: ${errMsg}`);
      } else {
        console.log(`VU ${vuId} | attempt ${r + 1}/${REPETITIONS} | status ${status} | ${url} | ${duration} ms`);
      }

      check(res, {
        'status is 2xx or 3xx': (r) => r && r.status >= 200 && r.status < 400,
      });

      // Delay between repeated requests to the same link
      sleep(DELAY_SECONDS);
    }
  }

  // Prevent immediate re-looping; adjust as needed
  sleep(60);
}
