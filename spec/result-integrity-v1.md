# OpenSourcesAI Bench — result integrity

Companion to [`protocol-v1.md`](protocol-v1.md). What a stored result establishes, what it cannot
establish, and where the boundary between the two falls.

**Status: draft, tracking issue #15.** The client-side half is implemented (`--verify`). The
server-side half is not, and cannot be built here — §5 says what it would need.

---

## 1. Threat model, stated before any mechanism

Three distinct things get conflated under "integrity", and only the first two are client-side
problems:

| Concern | Example | Addressable here |
|---|---|---|
| **Accidental corruption** | A truncated write, a botched merge, a result edited by hand to "fix" a figure | **Yes** |
| **Internal inconsistency** | Stored figures that do not follow from the stored measurements, whatever the cause | **Yes** |
| **Fabrication** | A record whose measurements never happened | **No — not by any client-side mechanism** |

The third deserves its own statement, because it is the one a reader will assume a word like
"verify" covers.

> **A self-produced artifact cannot establish its own authenticity.** Every check the client can
> run is a computation over data the producer controls, so anyone who can invent the data can also
> satisfy the check. This is not a gap in the current implementation to be closed later by a better
> hash or a signature; it is a property of the situation. A hash the client computes is a hash the
> forger computes too, and a key the client holds is a key the forger holds.

Nothing in this repository may describe a result as verified, authentic, or genuine on the strength
of a client-side check. `--verify` reports **CONSISTENT** or **INCONSISTENT**, and its own output
says what that does not mean.

---

## 2. What a stored result already establishes

Issue #15's completion criterion — *a result can be audited back to its protocol version, evidence
set, and validation outcome* — is met by the record format as it stands. The audit chain:

| Question | Field |
|---|---|
| Under what contract was this measured? | `protocolVersion` |
| Under what derivation rules were the figures computed? | `scoringVersion` |
| By what build? | `clientVersion` |
| On what runtime? | `runtime.name`, `runtime.version` |
| Of what model, exactly? | `model.identifier` plus `model.digest` — the runtime's own content hash of the weights, so a retagged or substituted model is a different record |
| Under what configuration? | `configuration.fixedOptions`, `configuration.workloads` (per workload: `numPredict`, `numCtx`, `keepAlive`, `promptTokenRange`, `warmups`, `repetitions`), `configuration.resolved` |
| Against what bandwidth figure, from where? | `configuration.memoryBandwidth*`, including the table version and entry id |
| On what machine? | `system` — GPU model, VRAM, driver, CPU, RAM, OS |
| Under what run conditions? | `qualityOverride`, `cohortEligible`, `qualityConditions`, `runtime.environment` (a **declaration**, never a reading — §8.4) |
| **What was actually measured?** | `rawMeasurements.workloads.*.measuredPasses[].attempts[].measurement` — every attempt, including the ones that failed and were retried |
| **What did validity say about each one?** | `attempts[].validity.valid` with the specific `reasons` |

The last two are the load-bearing ones. **Failed attempts are retained rather than discarded**, so
a record shows its own retries; and every attempt carries the verdict §5.4 returned for it, with
the reason codes. That is the evidence set and the validation outcome, in the record, per attempt.

---

## 3. `--verify`: making the audit executable

The format made the audit *possible*. Nothing made it *performable* — a reader had to trust that
the derived figures followed from the raw measurements, which is precisely the kind of claim that
should not require trust when it is arithmetic.

```sh
npx @opensourcesai/bench --verify ~/.osai/bench-results/<result>.json
```

Reads one local file. No Ollama, no network, no hardware — derivation is pure by construction
(§10), which is what makes this runnable by a reader who did not produce the record.

Four layers, each catching something the others cannot:

1. **Identity** — the fields above are present. A record missing its `scoringVersion` or its model
   digest cannot be audited to anything, and says so instead of passing quietly.
2. **Configuration conformance** — the workload parameters the record says it used are the ones its
   stated `protocolVersion` defines. A record claiming `osai-bench/1.3` with a widened W2 band is
   not a `1.3` record.
3. **Validity recomputation** — every stored attempt is re-run through §5.4 and the verdict compared
   with the stored one. This is a separate layer on purpose: derivation reads `valid` off the record
   rather than recomputing it, so a flipped verdict would propagate into every derived figure and a
   re-derivation *alone* would agree with it perfectly. It also compares each pass's stored
   measurement against its final attempt's, since the record holds that value twice and each layer
   reads a different copy.
4. **Derivation recomputation** — every derived figure is recomputed from the stored raw
   measurements and compared exactly. Recomputation is deterministic: same pure functions, same
   stored numbers, bit-identical results. A tolerance would only hide a real disagreement.

Layer 4 is skipped, with a stated reason, when the record's `scoringVersion` differs from the
client's. A scoring change **recomputes** history by design (§2), so a difference there is the
system working, and reporting it as a fault would teach readers to ignore the check.

**Exit codes:** `0` consistent, `4` inconsistent, `1` unreadable. A record that fails to parse and
a record that parses and disagrees with itself are different outcomes, and a script checking a
corpus needs to tell them apart.

---

## 4. What is deliberately not implemented

**A content hash of the record.** It would detect accidental corruption, which layers 2–4 already
detect more informatively — a hash says "something changed", while `--verify` says *which figure*
disagrees and *by how much*. Against deliberate editing it adds nothing at all, since recomputing
it is trivial. Its only real use is as a stable identity for server-side duplicate detection, and
that use case fixes the canonicalisation rules — exactly which fields, in exactly what order, with
exactly what number formatting — which must match whatever a server verifies. **Designing that
half in isolation means designing it twice.** It should land with the server that consumes it, not
before.

**Signing.** See §1. A signature made with a key the client ships proves possession of a key the
client ships.

---

## 5. The server-side half

Issue #15's remaining scope — *server challenges and replay/duplicate detection* — is not buildable
in this repository, and not only for want of a server. Each item below is a requirement on a
submission service that does not exist:

| Requirement | What it needs |
|---|---|
| **Replay detection** | A canonical record identity, and server-side storage of every identity already seen. The client cannot know what another machine submitted |
| **Challenge/response** | A server-issued nonce incorporated into the run and returned with the result, so a record cannot be produced before the challenge that requested it. This changes what the client does during a run and is a protocol-level addition, not a client fix |
| **Submitter identity** | Accounts. §8.2 gates every percentile on `n ≥ 10` distinct submitting **accounts**, and no account system exists |
| **Reviewer decision** | Somewhere to record a verification outcome per submission, and someone to record it |

Two constraints bound anything built here, and neither is negotiable:

- **This client makes no external network calls** — no telemetry, no upload, not stubbed, not
  behind a flag. A submission path is a separate program, not a mode of this one.
- **Whatever a server does, it is checking a self-produced artifact.** The strongest achievable
  position is *this record is internally consistent, was submitted under a challenge this server
  issued, and has not been submitted before* — which is meaningfully more than the client can say,
  and still is not proof a measurement happened. A submission pipeline should say what it checked,
  in those words, rather than stamping records "verified".

---

## 6. Consequences for anything that displays results

- **Never render a client-side check as a verification badge.** `--verify` establishes that
  arithmetic follows from data, and nothing about where the data came from.
- **`cohortEligible: false` is not a defect** — it means the run was overridden or refused a
  precondition, and its numbers remain what they are.
- **A record whose `scoringVersion` is not current is not stale**, because raw measurements are
  immutable and recomputable. Recompute it rather than discarding it.
- **`runtime.environment` is a declaration, never a reading** (§8.4). `unknown` must never be
  rendered as `comparable`.
