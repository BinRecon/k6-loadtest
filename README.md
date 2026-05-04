### Updated k6 script with per-link metrics and file-output logging

Below is a **single, ready-to-run k6 script** that:

- Crawls the **BASE_URL** in `setup()` and extracts same-origin links.
- Creates **per-link custom metrics** (Trend for response time, Counter for requests, Counter for failures) lazily and records them for every request.
- Logs request details to console (status, URL, response time, error).
- Is configurable via environment variables: **BASE_URL**, **REPETITIONS**, **DELAY_SECONDS**, **VUS**, **DURATION**.
- Shows how to **export metrics to a JSON file** and **save console logs to a file** when running k6.


---

### How to export metrics and logs to files

**1) Export k6 metrics (including custom metrics) to JSON file**

Run k6 with the `--out json=metrics.json` option. This writes all metrics (including the custom Trends and Counters created above) to `metrics.json`.

```bash
k6 run --out json=metrics.json -e BASE_URL=https://example.com -e REPETITIONS=10 -e DELAY_SECONDS=30 -e VUS=20 -e DURATION=60m load-test.js
```

**2) Save console logs (stdout/stderr) to a file**

Redirect stdout and stderr when running k6 so the console logs (the `console.log` / `console.error` lines in the script) are saved:

```bash
k6 run --out json=metrics.json -e BASE_URL=https://example.com -e REPETITIONS=10 -e DELAY_SECONDS=30 -e VUS=20 -e DURATION=60m load-test.js > k6_console.log 2>&1
```

- `metrics.json` will contain structured metric data you can parse or import into tools.
- `k6_console.log` will contain the per-request console lines (status, URL, response time, errors).

**3) Use other outputs**  
k6 supports many output backends (InfluxDB, Prometheus remote write, Datadog, etc.). Replace `--out json=metrics.json` with the desired output (e.g., `--out influxdb=http://host:8086/...`) if you want to push metrics to a monitoring system.

---

### How to analyze per-link metrics after the run

- **metrics.json** contains entries for each metric name you created (e.g., `rt_example_com_path`, `reqs_example_com_path`, `fails_example_com_path`). Use `jq`, Python, or import into a time-series DB to visualize trends and counts.
- Example quick `jq` to list metric names:
```bash
jq -r '.[].metric' metrics.json | sort | uniq
```
- For deeper analysis, import `metrics.json` into a script that aggregates `reqs_*` and `fails_*` per link and computes averages from `rt_*` Trend values.

---

### Notes and recommendations

- **Metric name length**: metric names are sanitized and truncated; ensure uniqueness for very long paths if you need exact mapping.
- **Cardinality**: creating a metric per unique link increases metric cardinality. For very large sites (thousands of links) consider grouping by path prefix or sampling a subset to avoid high cardinality in your metrics backend.
- **Large JSON files**: `--out json=metrics.json` can produce large files for long runs; rotate or stream to a DB for long-term storage.
- **Dynamic link discovery**: for JS-rendered links, pre-generate a link list with a headless browser and feed it to k6 (e.g., via `setup()` reading a JSON file).
- **If you want logs in structured format**: instead of console logs, you can `console.log(JSON.stringify({...}))` and then parse the log file.
