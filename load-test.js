import http from 'k6/http';
import { sleep, check } from 'k6';
import { parseHTML } from 'k6/html';

const BASE_URL = __ENV.BASE_URL || 'https://example.com';
const REPETITIONS = Number(__ENV.REPETITIONS || 10);
const DELAY_SECONDS = Number(__ENV.DELAY_SECONDS || 30);
const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || '30m';

export const options = {
  vus: VUS,
  duration: DURATION,
  // If you prefer a fixed number of iterations per VU, replace duration with iterations.
};

/* Small set of user agents */
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

function normalizeUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch (e) {
    return null;
  }
}

function isSameOrigin(urlA, urlB) {
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
  } catch (e) {
    return false;
  }
}

/* Crawl base URL and extract same-origin links (anchors + simple href regex) */
function crawlLinks(baseUrl) {
  const links = new Set();
  const res = http.get(baseUrl, { headers: { 'User-Agent': getRandomUserAgent() } });

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
    // parseHTML may fail on malformed HTML; ignore and continue
  }

  // fallback: simple regex scan for hrefs (best-effort)
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

/* Split links into contiguous chunks for VU assignment */
function chunkLinks(allLinks, totalVUs) {
  const chunks = Array.from({ length: totalVUs }, () => []);
  for (let i = 0; i < allLinks.length; i++) {
    const idx = i % totalVUs;
    chunks[idx].push(allLinks[i]);
  }
  // Ensure no VU has zero links: if some chunks empty, give them the base URL
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].length === 0) chunks[i].push(BASE_URL);
  }
  return chunks;
}

export function setup() {
  console.log(`Crawling ${BASE_URL} ...`);
  const links = crawlLinks(BASE_URL);
  console.log(`Discovered ${links.length} links (sample up to 20):`);
  links.slice(0, 20).forEach((l, i) => console.log(`  [${i}] ${l}`));
  return { links };
}

/* Each VU will run this once and perform all repetitions inside the same iteration */
export default function (data) {
  const allLinks = data.links || [BASE_URL];
  const vuId = __VU; // 1-based
  const totalVUs = options.vus || VUS;

  // Stagger start a little to avoid all VUs hitting at once
  sleep(Math.random() * 3);

  // Create chunks and pick this VU's chunk
  const chunks = chunkLinks(allLinks, totalVUs);
  const myLinks = chunks[vuId - 1] || [BASE_URL];

  console.log(`VU ${vuId} assigned ${myLinks.length} links.`);

  // For each assigned link, perform REPETITIONS with DELAY_SECONDS between requests
  for (let i = 0; i < myLinks.length; i++) {
    const url = myLinks[i];

    for (let r = 0; r < REPETITIONS; r++) {
      const headers = {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      };

      let res;
      try {
        res = http.get(url, { headers, timeout: '60s' });
      } catch (err) {
        // Network-level exception
        console.error(`VU ${vuId} ERROR (exception) ${url} attempt ${r + 1}/${REPETITIONS}: ${err}`);
        // still sleep before next attempt
        sleep(DELAY_SECONDS);
        continue;
      }

      // res may be undefined on some failures; handle gracefully
      const status = res && typeof res.status !== 'undefined' ? res.status : 0;
      const duration = res && res.timings && res.timings.duration ? res.timings.duration : 0;
      const errMsg = res && res.error ? res.error : '';

      if (status === 0) {
        console.error(`VU ${vuId} attempt ${r + 1}/${REPETITIONS} | status 0 | ${url} | ${duration} ms | error: ${errMsg}`);
      } else {
        console.log(`VU ${vuId} attempt ${r + 1}/${REPETITIONS} | status ${status} | ${url} | ${duration} ms`);
      }

      check(res, {
        'status is 2xx or 3xx': (r) => r && r.status >= 200 && r.status < 400,
      });

      // Wait before next repetition for the same link
      sleep(DELAY_SECONDS);
    }
  }

  // After finishing assigned links, sleep for a long time so this VU does not immediately start another iteration.
  // If you want the VU to repeat the whole cycle, reduce this sleep or remove it.
  sleep(60);
}
