interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * H-1B MCP — US H-1B visa sponsorship & wage data from DOL Labor Condition
 * Application (LCA) disclosures.
 *
 * Recruiting/talent use: "does company X sponsor H-1B?", "what does company X
 * pay for role Y?", "what are the H-1B wage ranges for a software engineer in
 * Seattle?". Each LCA record is a real, disclosed employer + job title + base
 * salary + work location + filing dates.
 *
 * SOURCE, TWO TIERS (fleet #2514). Primary: a Pipeworx-maintained local
 * mirror of DOL's own LCA disclosure files (dol.gov/agencies/eta/foreign-
 * labor/performance) — loaded by scripts/h1b-lca-upsert.sh /
 * .github/workflows/h1b-lca-refresh.yml into Supabase h1b_lca_disclosures,
 * schema + RPCs in supabase/migrations/222_h1b_lca_disclosures.sql. This
 * pack used to scrape h1bdata.info exclusively; that scrape capped at 20,000
 * HTML table rows per query (see fetchLcaLive below) so a large employer's
 * salary stats were silently computed from a truncated, non-representative
 * slice with nothing telling the caller. The local mirror has no such cap.
 *
 * Fallback: h1bdata.info, a third-party aggregator of the same DOL data,
 * used ONLY when the requested fiscal_year falls outside the local mirror's
 * currently loaded window (checked via h1b_lca_coverage() every call — the
 * mirror is loaded incrementally, not the full DOL archive back to 2001) or
 * when the DB is unreachable. Every response says which source actually
 * answered it (`source` field) — this pack never silently swaps sources.
 *
 * FISCAL YEAR, NOT CALENDAR YEAR, for the local mirror. DOL's own files are
 * organized by FEDERAL fiscal year (Oct 1 - Sep 30); `year` here is passed
 * straight through as that fiscal year. h1bdata.info's "year" filter is a
 * DIFFERENT, unverified semantic (most likely calendar year of filing) — a
 * query answered by the live fallback for the same `year` value is not
 * guaranteed to mean the identical 12-month window as one answered locally.
 * The response's `note`/`source` fields say which happened.
 *
 * NO PERSONAL DATA IN THE MIRROR (local-copy rule, task #2514). DOL's own
 * record layout (read in full 2026-09-29) carries named-individual contact
 * fields — the employer's point-of-contact name/email/phone, the
 * representing attorney/agent's name/email/phone, and the form preparer's
 * name/email. None of those are loaded; see the migration header for the
 * full column-by-column accounting. DOL's file already excludes the foreign
 * worker's own name/address — no worker PII was ever in this dataset.
 *
 * `data_as_of` is on every locally-served response (the local mirror's last
 * successful refresh, via h1b_lca_coverage()).
 *
 * Tools: h1b_employer_sponsorship, h1b_salary, h1b_top_sponsors (unchanged
 * names/arguments — only where the answer comes from changed).
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'H-1B');
}

const LIVE_BASE = 'https://h1bdata.info/index.php';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DB_QUERY_TIMEOUT_MS = 9000; // PostgREST's authenticated-role statement_timeout is 8s; just past it so a slow query surfaces as our message, not a bare abort.

const tools: McpToolExport['tools'] = [
  {
    name: 'h1b_employer_sponsorship',
    description:
      "Check whether a US employer sponsors H-1B visas and profile their sponsorship, from DOL Labor Condition Application (LCA) disclosures. Answers 'does company X sponsor H-1B / green cards' for recruiting and candidate advising. Returns the number of certified LCA filings, base-salary range (min / median / max), the top sponsored job titles, and top work locations for the employer. Filter by year (DOL federal fiscal year, Oct-Sep, for recent years); defaults to the latest full year. Employer name is matched as the disclosed legal name (e.g. 'Google', 'Amazon.com Services').",
    inputSchema: {
      type: 'object',
      properties: {
        employer: { type: 'string', description: 'Employer name to look up, e.g. "Google", "Deloitte", "Amazon".' },
        year: { type: ['number', 'string'], description: 'Filing year (e.g. 2024). Defaults to the most recent full year. Interpreted as DOL federal fiscal year (Oct-Sep) for recent years.' },
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

interface Coverage {
  min_fiscal_year: number | null;
  max_fiscal_year: number | null;
  total_rows: number;
  data_as_of: string | null;
}

function defaultYear(): number {
  // The latest full (federal fiscal or calendar) year lags ~1 year behind
  // "now". Deterministic (Date.now is available in workers) but bounded to
  // avoid a future year with no data.
  const y = new Date().getUTCFullYear();
  return y - 1;
}

function yearArg(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 2001 && n <= 2100 ? n : defaultYear();
}

// ── Local DOL mirror (primary) ──────────────────────────────────────────

async function dbRpc<T>(
  supabaseUrl: string | undefined,
  supabaseKey: string | undefined,
  fn: string,
  body: Record<string, unknown>,
): Promise<T[] | null> {
  if (!supabaseUrl || !supabaseKey) return null; // not injected -> caller falls back to the live scrape
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DB_QUERY_TIMEOUT_MS);
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    // Any non-2xx (including an empty/not-yet-migrated table before the
    // first load runs) falls through to the live scrape rather than
    // erroring the whole tool call — this pack must never regress below
    // its pre-#2514 behavior while the mirror is still being backfilled.
    if (!res.ok) return null;
    return (await res.json()) as T[];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getCoverage(supabaseUrl: string | undefined, supabaseKey: string | undefined): Promise<Coverage | null> {
  const rows = await dbRpc<Coverage>(supabaseUrl, supabaseKey, 'h1b_lca_coverage', {});
  const row = rows?.[0];
  if (!row || row.total_rows === 0) return null;
  return row;
}

function yearInCoverage(year: number, coverage: Coverage | null): boolean {
  if (!coverage || coverage.min_fiscal_year == null || coverage.max_fiscal_year == null) return false;
  return year >= coverage.min_fiscal_year && year <= coverage.max_fiscal_year;
}

interface DbLcaRow {
  employer_name: string;
  job_title: string;
  base_salary_annual: number | null;
  worksite_city: string | null;
  worksite_state: string | null;
  received_date: string | null;
  begin_date: string | null;
}

async function fetchLcaFromDb(
  supabaseUrl: string | undefined,
  supabaseKey: string | undefined,
  params: { em?: string; job?: string; city?: string; year: number },
): Promise<LcaRecord[] | null> {
  const rows = await dbRpc<DbLcaRow>(supabaseUrl, supabaseKey, 'h1b_lca_search', {
    p_employer: params.em || null,
    p_job_title: params.job || null,
    p_worksite_city: params.city || null,
    p_fiscal_year: params.year,
    p_limit: 20000,
    p_any_status: false,
  });
  if (rows === null) return null;
  return rows.map((r) => ({
    employer: r.employer_name,
    job_title: r.job_title,
    base_salary: r.base_salary_annual,
    location: [r.worksite_city, r.worksite_state].filter(Boolean).join(', '),
    submit_date: r.received_date ?? '',
    start_date: r.begin_date ?? '',
  }));
}

interface DbStatsRow {
  lca_filings: number;
  with_salary: number;
  min_salary: number | null;
  median_salary: number | null;
  avg_salary: number | null;
  max_salary: number | null;
  top_job_titles: { value: string; count: number }[];
  top_locations: { value: string; count: number }[];
  top_employers: { value: string; count: number }[];
}

// Aggregate stats over ALL matching rows, computed server-side in one
// function call (migration 223) — replaces fetching row-level records via
// h1b_lca_search and counting/aggregating them in JS, which is exactly the
// shape Supabase's db-max-rows=1000 cap silently truncates: any employer
// with more than 1000 matching LCA filings (e.g. Google, ~7,448 certified
// rows) came back as a clean 200 with lca_filings capped at 1000 and no
// signal that anything was cut (verified live 2026-09-30). h1b_top_sponsors
// was never affected by this because it GROUPs before returning; this gives
// h1b_employer_sponsorship and h1b_salary the same shape.
async function fetchStatsFromDb(
  supabaseUrl: string | undefined,
  supabaseKey: string | undefined,
  params: { em?: string; job?: string; city?: string; year: number; topN?: number },
): Promise<DbStatsRow | null> {
  const rows = await dbRpc<DbStatsRow>(supabaseUrl, supabaseKey, 'h1b_lca_stats', {
    p_employer: params.em || null,
    p_job_title: params.job || null,
    p_worksite_city: params.city || null,
    p_fiscal_year: params.year,
    p_any_status: false,
    p_top_n: params.topN ?? 10,
  });
  return rows?.[0] ?? null;
}

interface DbTopSponsorRow {
  employer_name: string;
  lca_filings: number;
  median_base_salary: number | null;
  total_all_filings: number;
}

async function fetchTopSponsorsFromDb(
  supabaseUrl: string | undefined,
  supabaseKey: string | undefined,
  params: { job: string; city?: string; year: number; limit: number },
): Promise<DbTopSponsorRow[] | null> {
  return dbRpc<DbTopSponsorRow>(supabaseUrl, supabaseKey, 'h1b_top_sponsors', {
    p_job_title: params.job,
    p_worksite_city: params.city || null,
    p_fiscal_year: params.year,
    p_limit: params.limit,
  });
}

// ── h1bdata.info (fallback, used only outside the local mirror's loaded window) ──

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
}

async function fetchLcaLive(params: { em?: string; job?: string; city?: string; year: number }): Promise<LcaRecord[]> {
  const qs = new URLSearchParams({
    em: params.em ?? '',
    job: params.job ?? '',
    city: params.city ?? '',
    year: String(params.year),
  });
  const res = await pwFetch(`${LIVE_BASE}?${qs}`, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) throw await httpError(res, 'upstream_down: h1bdata');
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
    if (records.length >= 20000) break; // safety cap on huge employers — this is the truncation the local mirror exists to remove
  }
  return records;
}

// ── shared stats (source-agnostic — same LcaRecord[] shape from either path) ──

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

// ── tools ────────────────────────────────────────────────────────────────

async function employerSponsorship(supabaseUrl: string | undefined, supabaseKey: string | undefined, args: Record<string, unknown>): Promise<unknown> {
  const employer = typeof args.employer === 'string' ? args.employer.trim() : '';
  if (!employer) return { error: 'user_error', message: 'Pass an employer name, e.g. {"employer": "Google"}.' };
  const year = yearArg(args.year);

  const coverage = await getCoverage(supabaseUrl, supabaseKey);
  const useDb = yearInCoverage(year, coverage);
  const stats = useDb ? await fetchStatsFromDb(supabaseUrl, supabaseKey, { em: employer, year, topN: 10 }) : null;

  if (stats !== null) {
    // Aggregated server-side over EVERY matching row (migration 223) — never
    // a truncated sample, however large the employer.
    if (stats.lca_filings === 0) {
      return {
        employer,
        year,
        sponsors_h1b: false,
        source: 'dol_lca_disclosures',
        data_as_of: coverage?.data_as_of ?? null,
        message: `No certified H-1B LCA filings found for an employer matching "${employer}" in ${year}. They may not sponsor, may file under a different legal name, or had no filings that year (try another year).`,
      };
    }
    return {
      employer,
      year,
      sponsors_h1b: true,
      source: 'dol_lca_disclosures',
      data_as_of: coverage?.data_as_of ?? null,
      lca_filings: stats.lca_filings,
      matched_employers: stats.top_employers.map((e) => e.value),
      base_salary_usd: { min: stats.min_salary, median: stats.median_salary, average: stats.avg_salary, max: stats.max_salary },
      top_job_titles: stats.top_job_titles,
      top_locations: stats.top_locations,
      note: `Certified LCA filings ≈ the employer intends to sponsor for these roles; actual visa grants differ. Source: DOL LCA disclosures (federal fiscal year ${year}, Oct-Sep). Aggregated over every matching filing, not a truncated sample.`,
    };
  }

  // Fallback: local mirror unavailable (year outside its loaded window, DB
  // unreachable, or migration 223 not yet applied) — live scrape, unchanged
  // from pre-#2514 behavior (including its own 20,000-row cap).
  const finalRecs = await fetchLcaLive({ em: employer, year });
  if (finalRecs.length === 0) {
    return {
      employer,
      year,
      sponsors_h1b: false,
      source: 'h1bdata.info (live)',
      data_as_of: null,
      message: `No certified H-1B LCA filings found for an employer matching "${employer}" in ${year}. They may not sponsor, may file under a different legal name, or had no filings that year (try another year).`,
    };
  }
  const liveStats = salaryStats(finalRecs);
  return {
    employer,
    year,
    sponsors_h1b: true,
    source: 'h1bdata.info (live)',
    data_as_of: null,
    lca_filings: finalRecs.length,
    matched_employers: topN(finalRecs, 'employer', 5).map((e) => e.value),
    base_salary_usd: { min: liveStats.min, median: liveStats.median, average: liveStats.average, max: liveStats.max },
    top_job_titles: topN(finalRecs, 'job_title', 10),
    top_locations: topN(finalRecs, 'location', 10),
    note: `Certified LCA filings ≈ the employer intends to sponsor for these roles; actual visa grants differ. Source: DOL LCA disclosures via h1bdata.info (year ${year}).`,
  };
}

async function salary(supabaseUrl: string | undefined, supabaseKey: string | undefined, args: Record<string, unknown>): Promise<unknown> {
  const job = typeof args.job_title === 'string' ? args.job_title.trim() : '';
  if (!job) return { error: 'user_error', message: 'Pass a job_title, e.g. {"job_title": "software engineer"}.' };
  const year = yearArg(args.year);
  const employer = typeof args.employer === 'string' ? args.employer.trim() : undefined;
  const city = typeof args.city === 'string' ? args.city.trim().toUpperCase() : undefined;
  const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);

  const coverage = await getCoverage(supabaseUrl, supabaseKey);
  const useDb = yearInCoverage(year, coverage);
  // Stats aggregated over EVERY matching row server-side (migration 223) —
  // both employer AND job_title applied together in SQL, unlike the old
  // row-level path this replaces (which fetched by employer alone and
  // filtered job_title client-side, after truncation to whatever the RPC's
  // row cap let through).
  const stats = useDb ? await fetchStatsFromDb(supabaseUrl, supabaseKey, { em: employer, job, city, year }) : null;

  if (stats !== null) {
    if (stats.lca_filings === 0) {
      return {
        job_title: job,
        year,
        employer: employer ?? null,
        city: city ?? null,
        source: 'dol_lca_disclosures',
        data_as_of: coverage?.data_as_of ?? null,
        count: 0,
        message: 'No H-1B salary records matched. Try a broader title, a different year, or removing the employer/city filter.',
      };
    }
    // Small, explicitly bounded sample (max 50) — far under the 1000-row
    // cap, so unlike the stats above it is safe to fetch via h1b_lca_search.
    const sampleRecs = (await fetchLcaFromDb(supabaseUrl, supabaseKey, { em: employer, job, city, year })) ?? [];
    return {
      job_title: job,
      year,
      employer: employer ?? null,
      city: city ?? null,
      source: 'dol_lca_disclosures',
      data_as_of: coverage?.data_as_of ?? null,
      base_salary_usd: { count: stats.with_salary, min: stats.min_salary, median: stats.median_salary, average: stats.avg_salary, max: stats.max_salary },
      sample: sampleRecs.slice(0, limit).map((r) => ({ employer: r.employer, title: r.job_title, base_salary: r.base_salary, location: r.location, start_date: r.start_date })),
      note: `Real disclosed base salaries from DOL LCA filings (federal fiscal year ${year}) — a market wage benchmark. Aggregated over every matching filing (${stats.lca_filings} total), not a truncated sample.`,
    };
  }

  // Fallback: local mirror unavailable — live scrape, unchanged from
  // pre-#2514 behavior.
  const recs = (await fetchLcaLive({ em: employer, job: employer ? undefined : job, city, year })).filter((r) =>
    r.job_title.toLowerCase().includes(job.toLowerCase()),
  );

  if (recs.length === 0) {
    return {
      job_title: job,
      year,
      employer: employer ?? null,
      city: city ?? null,
      source: 'h1bdata.info (live)',
      data_as_of: null,
      count: 0,
      message: 'No H-1B salary records matched. Try a broader title, a different year, or removing the employer/city filter.',
    };
  }
  const liveStats = salaryStats(recs);
  return {
    job_title: job,
    year,
    employer: employer ?? null,
    city: city ?? null,
    source: 'h1bdata.info (live)',
    data_as_of: null,
    base_salary_usd: { count: liveStats.with_salary, min: liveStats.min, median: liveStats.median, average: liveStats.average, max: liveStats.max },
    sample: recs.slice(0, limit).map((r) => ({ employer: r.employer, title: r.job_title, base_salary: r.base_salary, location: r.location, start_date: r.start_date })),
    note: `Real disclosed base salaries from DOL H-1B LCA filings — a market wage benchmark. Source: h1bdata.info (year ${year}).`,
  };
}

async function topSponsors(supabaseUrl: string | undefined, supabaseKey: string | undefined, args: Record<string, unknown>): Promise<unknown> {
  const job = typeof args.job_title === 'string' ? args.job_title.trim() : '';
  if (!job) return { error: 'user_error', message: 'Pass a job_title, e.g. {"job_title": "data engineer"}.' };
  const year = yearArg(args.year);
  const city = typeof args.city === 'string' ? args.city.trim().toUpperCase() : undefined;
  const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);

  const coverage = await getCoverage(supabaseUrl, supabaseKey);
  const useDb = yearInCoverage(year, coverage);

  if (useDb) {
    const dbSponsors = await fetchTopSponsorsFromDb(supabaseUrl, supabaseKey, { job, city, year, limit });
    if (dbSponsors !== null) {
      if (dbSponsors.length === 0) {
        return {
          job_title: job,
          year,
          city: city ?? null,
          source: 'dol_lca_disclosures',
          data_as_of: coverage?.data_as_of ?? null,
          count: 0,
          message: 'No H-1B sponsors matched. Try a broader title, a different year, or removing the city filter.',
        };
      }
      return {
        job_title: job,
        year,
        city: city ?? null,
        source: 'dol_lca_disclosures',
        data_as_of: coverage?.data_as_of ?? null,
        total_filings: dbSponsors[0].total_all_filings,
        top_sponsors: dbSponsors.map((s) => ({ employer: s.employer_name, lca_filings: s.lca_filings, median_base_salary: s.median_base_salary })),
        note: `Employers ranked by certified H-1B LCA filings for this role — a sourcing/target-account signal. Source: DOL LCA disclosures (federal fiscal year ${year}). Ranked over ALL matching filings, not a truncated sample.`,
      };
    }
  }

  // Fallback: live scrape, grouped client-side (unchanged from pre-#2514 behavior).
  const recs = (await fetchLcaLive({ job, city, year })).filter((r) => r.job_title.toLowerCase().includes(job.toLowerCase()));
  if (recs.length === 0) {
    return { job_title: job, year, city: city ?? null, source: 'h1bdata.info (live)', count: 0, message: 'No H-1B sponsors matched. Try a broader title, a different year, or removing the city filter.' };
  }
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
    source: 'h1bdata.info (live)',
    total_filings: recs.length,
    top_sponsors: sponsors,
    note: `Employers ranked by certified H-1B LCA filings for this role — a sourcing/target-account signal. Source: DOL LCA disclosures via h1bdata.info (year ${year}; total_filings is capped at 20,000 raw rows).`,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const supabaseUrl = args._supabaseUrl as string | undefined;
  const supabaseKey = args._supabaseKey as string | undefined;
  try {
    switch (name) {
      case 'h1b_employer_sponsorship':
        return await employerSponsorship(supabaseUrl, supabaseKey, args);
      case 'h1b_salary':
        return await salary(supabaseUrl, supabaseKey, args);
      case 'h1b_top_sponsors':
        return await topSponsors(supabaseUrl, supabaseKey, args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
