interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * H-1B MCP — US H-1B visa sponsorship & wage data from DOL Labor Condition
 * Application (LCA) disclosures, keyless.
 *
 * Recruiting/talent use: "does company X sponsor H-1B?", "what does company X
 * pay for role Y?", "what are the H-1B wage ranges for a software engineer in
 * Seattle?". Each LCA record is a real, disclosed employer + job title + base
 * salary + work location + filing dates.
 *
 * Source: h1bdata.info, which aggregates the DOL FLAG LCA disclosure files into
 * a searchable table (query params em=employer, job=title, city, year). We fetch
 * and AGGREGATE the rows into the summaries recruiters actually need rather than
 * dumping raw records. If this third-party ever breaks, the authoritative
 * fallback is the DOL FLAG bulk disclosure data at flag.dol.gov (host-and-index).
 */


const BASE = 'https://h1bdata.info/index.php';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const tools: McpToolExport['tools'] = [
  {
    name: 'h1b_employer_sponsorship',
    description:
      "Check whether a US employer sponsors H-1B visas and profile their sponsorship, from DOL Labor Condition Application (LCA) disclosures. Answers 'does company X sponsor H-1B / green cards' for recruiting and candidate advising. Returns the number of certified LCA filings, base-salary range (min / median / max), the top sponsored job titles, and top work locations for the employer. Filter by year (defaults to the latest full year). Employer name is matched as the disclosed legal name (e.g. 'Google', 'Amazon.com Services').",
    inputSchema: {
      type: 'object',
      properties: {
        employer: { type: 'string', description: 'Employer name to look up, e.g. "Google", "Deloitte", "Amazon".' },
        year: { type: ['number', 'string'], description: 'Filing year (e.g. 2024). Defaults to the most recent full year.' },
      },
      required: ['employer'],
    },
  },
  {
    name: 'h1b_salary',
    description:
      "Look up real H-1B base salaries for a job title from DOL LCA disclosures — a market wage benchmark backed by actual filed salaries (not estimates). Answers 'what do H-1B software engineers earn at company X / in city Y'. Filter by job title, and optionally by employer, city, and year. Returns salary statistics (count, min / median / average / max) plus a sample of individual records (employer, title, salary, location, dates).",
    inputSchema: {
      type: 'object',
      properties: {
        job_title: { type: 'string', description: 'Job title to search, e.g. "software engineer", "data scientist". Matched as a substring of the disclosed title.' },
        employer: { type: 'string', description: 'Optional employer name to scope to, e.g. "Meta".' },
        city: { type: 'string', description: 'Optional work city, e.g. "SEATTLE" or "NEW YORK".' },
        year: { type: ['number', 'string'], description: 'Filing year (e.g. 2024). Defaults to the most recent full year.' },
        limit: { type: ['number', 'string'], description: 'Max sample records to return (default 15, max 50).' },
      },
      required: ['job_title'],
    },
  },
  {
    name: 'h1b_top_sponsors',
    description:
      "Find which US employers sponsor the most H-1B visas for a given job title (optionally in a specific city) — a candidate-sourcing / target-account signal for recruiting. Answers 'which companies sponsor the most data engineers in Austin' or 'top H-1B sponsors for nurses'. Returns employers ranked by certified LCA filings for the role, each with their filing count and median base salary. Backed by real DOL LCA disclosures.",
    inputSchema: {
      type: 'object',
      properties: {
        job_title: { type: 'string', description: 'Job title to rank sponsors for, e.g. "data engineer", "physical therapist".' },
        city: { type: 'string', description: 'Optional work city to scope to, e.g. "AUSTIN" or "NEW YORK".' },
        year: { type: ['number', 'string'], description: 'Filing year (e.g. 2024). Defaults to the most recent full year.' },
        limit: { type: ['number', 'string'], description: 'Max employers to return (default 15, max 50).' },
      },
      required: ['job_title'],
    },
  },
];

interface LcaRecord {
  employer: string;
  job_title: string;
  base_salary: number | null;
  location: string;
  submit_date: string;
  start_date: string;
}

function defaultYear(): number {
  // h1bdata is organized by filing year; the latest full year lags ~1 year.
  // Deterministic (Date.now is available in workers) but bounded to avoid a
  // future year with no data.
  const y = new Date().getUTCFullYear();
  return y - 1;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
}

async function fetchLca(params: { em?: string; job?: string; city?: string; year: number }): Promise<LcaRecord[]> {
  const qs = new URLSearchParams({
    em: params.em ?? '',
    job: params.job ?? '',
    city: params.city ?? '',
    year: String(params.year),
  });
  const res = await fetch(`${BASE}?${qs}`, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`upstream_down: h1bdata ${res.status}`);
  // Strip ad injections (ezoic/adsense) that get inlined into table cells —
  // otherwise "(adsbygoogle = ...)" leaks into employer/title text.
  const html = (await res.text())
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<ins[\s\S]*?<\/ins>/gi, '');
  const records: LcaRecord[] = [];
  // Rows are <tr><td>EMPLOYER</td><td>TITLE</td><td>SALARY</td><td>LOCATION</td><td>SUBMIT</td><td>START</td></tr>
  const rowRe = /<tr>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>/gs;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const sal = Number(stripTags(m[3]).replace(/[^0-9.]/g, ''));
    records.push({
      employer: stripTags(m[1]),
      job_title: stripTags(m[2]),
      base_salary: Number.isFinite(sal) && sal > 0 ? sal : null,
      location: stripTags(m[4]),
      submit_date: stripTags(m[5]),
      start_date: stripTags(m[6]),
    });
    if (records.length >= 20000) break; // safety cap on huge employers
  }
  return records;
}

function salaryStats(recs: LcaRecord[]) {
  const sals = recs.map((r) => r.base_salary).filter((n): n is number => n != null).sort((a, b) => a - b);
  if (sals.length === 0) return { count: recs.length, with_salary: 0, min: null, median: null, average: null, max: null };
  const sum = sals.reduce((a, b) => a + b, 0);
  return {
    count: recs.length,
    with_salary: sals.length,
    min: sals[0],
    median: sals[Math.floor(sals.length / 2)],
    average: Math.round(sum / sals.length),
    max: sals[sals.length - 1],
  };
}

function topN(recs: LcaRecord[], key: 'job_title' | 'location' | 'employer', n: number) {
  const counts = new Map<string, number>();
  for (const r of recs) {
    const v = r[key];
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }));
}

function yearArg(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 2001 && n <= 2100 ? n : defaultYear();
}

async function employerSponsorship(args: Record<string, unknown>): Promise<unknown> {
  const employer = typeof args.employer === 'string' ? args.employer.trim() : '';
  if (!employer) return { error: 'user_error', message: 'Pass an employer name, e.g. {"employer": "Google"}.' };
  const year = yearArg(args.year);
  const recs = await fetchLca({ em: employer, year });
  if (recs.length === 0) {
    return {
      employer,
      year,
      sponsors_h1b: false,
      message: `No certified H-1B LCA filings found for an employer matching "${employer}" in ${year}. They may not sponsor, may file under a different legal name, or had no filings that year (try another year).`,
    };
  }
  const stats = salaryStats(recs);
  return {
    employer,
    year,
    sponsors_h1b: true,
    lca_filings: recs.length,
    matched_employers: topN(recs, 'employer', 5).map((e) => e.value),
    base_salary_usd: { min: stats.min, median: stats.median, average: stats.average, max: stats.max },
    top_job_titles: topN(recs, 'job_title', 10),
    top_locations: topN(recs, 'location', 10),
    note: 'Certified LCA filings ≈ the employer intends to sponsor for these roles; actual visa grants differ. Source: DOL LCA disclosures via h1bdata.info.',
  };
}

async function salary(args: Record<string, unknown>): Promise<unknown> {
  const job = typeof args.job_title === 'string' ? args.job_title.trim() : '';
  if (!job) return { error: 'user_error', message: 'Pass a job_title, e.g. {"job_title": "software engineer"}.' };
  const year = yearArg(args.year);
  const employer = typeof args.employer === 'string' ? args.employer.trim() : undefined;
  const city = typeof args.city === 'string' ? args.city.trim().toUpperCase() : undefined;
  const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);

  // h1bdata's job filter is exact-ish; fetch by employer+year (or job+year) and
  // filter the title substring client-side for flexible matching.
  const recs = (await fetchLca({ em: employer, job: employer ? undefined : job, city, year })).filter((r) =>
    r.job_title.toLowerCase().includes(job.toLowerCase()),
  );
  if (recs.length === 0) {
    return { job_title: job, year, employer: employer ?? null, city: city ?? null, count: 0, message: 'No H-1B salary records matched. Try a broader title, a different year, or removing the employer/city filter.' };
  }
  const stats = salaryStats(recs);
  return {
    job_title: job,
    year,
    employer: employer ?? null,
    city: city ?? null,
    base_salary_usd: { count: stats.with_salary, min: stats.min, median: stats.median, average: stats.average, max: stats.max },
    sample: recs.slice(0, limit).map((r) => ({ employer: r.employer, title: r.job_title, base_salary: r.base_salary, location: r.location, start_date: r.start_date })),
    note: 'Real disclosed base salaries from DOL H-1B LCA filings — a market wage benchmark. Source: h1bdata.info.',
  };
}

async function topSponsors(args: Record<string, unknown>): Promise<unknown> {
  const job = typeof args.job_title === 'string' ? args.job_title.trim() : '';
  if (!job) return { error: 'user_error', message: 'Pass a job_title, e.g. {"job_title": "data engineer"}.' };
  const year = yearArg(args.year);
  const city = typeof args.city === 'string' ? args.city.trim().toUpperCase() : undefined;
  const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);
  const recs = (await fetchLca({ job, city, year })).filter((r) => r.job_title.toLowerCase().includes(job.toLowerCase()));
  if (recs.length === 0) {
    return { job_title: job, year, city: city ?? null, count: 0, message: 'No H-1B sponsors matched. Try a broader title, a different year, or removing the city filter.' };
  }
  // Group by employer → count + median salary.
  const byEmployer = new Map<string, number[]>();
  for (const r of recs) {
    const list = byEmployer.get(r.employer) ?? [];
    if (r.base_salary != null) list.push(r.base_salary);
    byEmployer.set(r.employer, list);
  }
  const counts = new Map<string, number>();
  for (const r of recs) counts.set(r.employer, (counts.get(r.employer) ?? 0) + 1);
  const sponsors = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([employer, filings]) => {
      const sals = (byEmployer.get(employer) ?? []).sort((a, b) => a - b);
      return { employer, lca_filings: filings, median_base_salary: sals.length ? sals[Math.floor(sals.length / 2)] : null };
    });
  return {
    job_title: job,
    year,
    city: city ?? null,
    total_filings: recs.length,
    top_sponsors: sponsors,
    note: 'Employers ranked by certified H-1B LCA filings for this role — a sourcing/target-account signal. Source: DOL LCA disclosures.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'h1b_employer_sponsorship':
        return await employerSponsorship(args);
      case 'h1b_salary':
        return await salary(args);
      case 'h1b_top_sponsors':
        return await topSponsors(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
