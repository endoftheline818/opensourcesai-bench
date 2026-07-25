# OpenSourcesAI Bench — Project Guide

## What this is

A local LLM inference benchmark utility, published as the scoped npm package
`@opensourcesai/bench` under the `opensourcesai` npm organization. It measures a user's actual
installed configuration — generation and prefill throughput, time to first token, cold load
time, run-to-run variance — against a fixed protocol, so that results are comparable over time
and across machines.

It supports opensourcesai.com but is **a separate product with a separate lifecycle**. It is not
part of the website, it is never merged into the website repository, and it does not import from
it. The two are joined only by a versioned result-JSON contract.

**This repository will become public.** Assume every commit, comment, and branch name is
publishable. No keys, no internal strategy notes, no cross-references to private planning.

## The governing document

**`spec/protocol-v1.md` is the measurement contract.** Read it before changing anything that
affects what is measured, how it is measured, or how results are derived.

Every decision in it was made deliberately, with the reasoning recorded in the document and in
the commit that added it. **Do not re-derive, "improve", simplify, or quietly deviate from it.**
If something in it is wrong, say so and leave the code conforming — then change the spec in its
own commit, with the rationale, and bump the protocol version.

Spec §12 lists open questions that hardware testing has not closed. **None of them are settled.**
Where code must pick a value to run, mark it in-line as provisional and reference the §12 item.

## Hard rules

These exist because the tool asks people to run it against their own machine. Every one of them
is a trust property, not a preference.

- **No network access except the local Ollama endpoint.** No telemetry, no upload, no update
  check, no analytics, no crash reporting. Not implemented, not stubbed, not commented out, not
  behind a disabled flag. An audit of this package must find zero outbound calls.
- **No composite or aggregate score.** No overall score, no 0–100 normalization, no letter grade,
  no weighted combination of metrics. Weights can only be justified by data that does not exist
  yet; shipping arbitrary ones means either living with them forever or moving every user's score
  later for reasons they did not cause.
- **No asserted performance targets.** Never state or imply what a well-configured system "should"
  reach. Permitted comparisons are (a) roofline utilization computed per spec §6.2 with its stated
  limits attached, and (b) conditions *detected* directly from the runtime per spec §7. Anything
  else is false precision.
- **No thermal or temperature measurement.** Excluded by design — reporting is inconsistent across
  platforms, and thermals reflect ambient conditions rather than setup quality.
- **Never relax the validity checks** in spec §5.4 to make a run pass. A failed run is data.
- **No registry credentials in the repository.** Publishing uses GitHub Actions OIDC trusted
  publishing with provenance. Never reference `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or any stored token
  in a workflow. The npm account requires 2FA for publishing; a token that bypasses it is exactly
  what npm is restricting.

## Dependency policy

**Keep runtime dependencies at or near zero.** Every dependency is something a security-conscious
user has to audit before trusting the tool, and supply-chain surface on a package whose entire
value is that it can be trusted. Node's built-ins cover HTTP, filesystem, and argument parsing.

Any runtime dependency needs a justification in the commit that adds it. Dev dependencies for
testing are acceptable, kept minimal.

## Architecture

A hard module boundary, load-bearing for testability:

| Layer | Rule |
|---|---|
| **Collection** (`src/adapters/*`) | One adapter per runtime. Talks to the runtime, captures raw responses, returns them unmodified. The only code that performs I/O. |
| **Derivation** | Pure functions over raw measurements. Throughput, utilization, variance, validity, diagnostics. Data in, data out, no I/O. |

**Derivation must be fully testable with no GPU and no runtime installed**, against committed
fixtures of real recorded responses in `fixtures/` — including at least one from a deliberately
misconfigured setup. This is what makes the protocol safe to evolve later. Do not retrofit it.

**Raw measurements are immutable and authoritative.** Every derived figure is recomputable from
them, so a scoring change recomputes history rather than orphaning it.

## Release gate

Before the first public release, the protocol must be run against a knowingly broken configuration
— forced partial offload, oversized context, forced CPU fallback — and shown to produce materially
worse numbers *and* fire the corresponding spec §7 diagnostics (spec §11).

**If a badly configured machine scores well, the protocol measures nothing.** This gates the
protocol freeze. Do not publish before it passes.

## Working conventions

- Branch and open a PR (`feat/`, `fix/`, `docs/`, `chore/` + kebab slug). Do not push to `main`
  and do not force-push. The founder merges.
- Do not add AI attribution or co-author trailers to commits.
- Commit messages record *why*, not just *what* — the reasoning behind a measurement decision is
  the most valuable thing in this repository's history.
- `package.json` must carry `"publishConfig": { "access": "public" }`. Scoped packages default to
  private and the first publish fails without it.
- Do not publish to npm from a session. Releases are a deliberate founder action.

## Relationship to opensourcesai.com

The website repository holds a companion policy, `docs/benchmark-data-governance.md`, governing
what benchmark data may influence on site surfaces — it may calibrate expected-performance ranges,
diagnostics, and confidence labels, but may never influence hardware ranking, tier selection, or
affiliate routing.

**That policy binds the website, not this repository.** This tool has no concept of rankings,
tiers, partners, or affiliate links, and must never acquire one. If a change here would only make
sense in order to influence something on the site, it belongs in neither place.
