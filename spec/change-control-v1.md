# OpenSourcesAI Bench — change control and freeze criteria

Companion to [`protocol-v1.md`](protocol-v1.md). That document is the measurement contract. This
one governs how it is allowed to change, what "frozen" will mean when it happens, and what
currently stands between the protocol and that point.

**Status: draft, tracking issue #14. The protocol is not frozen, and this document does not freeze
it.** Declaring the freeze is a maintainer decision; §5 below is the checklist it would be taken
against, not the decision itself.

---

## 1. What a freeze is, and is not

**Freezing v1 means: no change may alter what a `osai-bench/1.3` record means.** A figure recorded
before the freeze and a figure recorded after it are the same measurement of the same thing, and
may be compared directly.

It does **not** mean the repository stops changing. Client fixes, new fixtures, new hardware in the
bandwidth table, documentation, and derivation corrections that recompute rather than redefine all
remain possible — and remain necessary, since a frozen protocol with an unmaintained client is not
a stable measurement, only an unmaintained one.

The distinction is the whole content of this document, so it gets a rule rather than a vibe (§3).

---

## 2. The three versions

Defined in protocol §2, restated here only as far as change control needs. §2 is authoritative;
if this section ever disagrees with it, §2 wins.

| Version | Moves when |
|---|---|
| `protocolVersion` | Measurement semantics change. Records with different values are **distinct populations and are never pooled** |
| `scoringVersion` | Derivation rules change. Raw measurements are immutable, so a scoring change **recomputes** history rather than orphaning it |
| `clientVersion` | The npm package changes at all |

Every result and every fixture carries all of the relevant ones. That is what makes a record
auditable back to the rules that produced it.

---

## 3. Deciding which version a change moves

Ask, in order:

1. **Would a record produced before this change and one produced after it still be measuring the
   same thing?** If no → `protocolVersion`. This is the only question that matters, and it is
   answered about the *measurement*, not about the diff.
2. **Does the change alter a derived figure computable from unchanged raw measurements?**
   If yes → `scoringVersion`. Recompute the affected fixtures and confirm the new rule reproduces
   the intended figures from the same raw data.
3. **Otherwise** → `clientVersion` only.

`clientVersion` moves in every case, because the package changed. The question is only whether one
of the other two moves *with* it.

### 3.1 Worked examples from this repository's own history

| Change | Moved | Why |
|---|---|---|
| W3 gains a per-call cache-bust marker (protocol 1.3) | **protocol** | Prefill was previously reading a KV-cache hit, not a measurement. Post-change W3 measures something the pre-change W3 did not |
| W3 prompt resized and the prompt-length validity rule replaced (protocol 1.2) | **protocol** | Both the prompt and the acceptance rule changed |
| TTFT counts the first token in the *thinking* channel too (client 0.7.0) | **client** | Conformance to §5.2's existing "first streamed token" wording. Non-thinking runs are byte-identical; the fix only turned a wrong `null` into a real number |
| Placement diagnostics stop asserting "CPU-only" when the runtime reports the model resident in VRAM (scoring 1.5) | **scoring** | Derivation rules changed; the raw `/api/ps` bytes did not |
| §3's OS row gains an enforcing §4 condition (client 0.13.0) | **client** | Enforcement of a limit §3 always documented, through refuse/override machinery that already existed. No workload, fixed parameter or timing rule changed |
| §4 gains a prompt-band precondition (proposed, #32) | **client** | Same shape: §5.4's band and truncation rules are asked earlier, by the same shared implementation. A prompt the check admits is one §5.4 already accepted |

The last two are the ones worth studying, because both *look* like protocol changes — a new
refusal condition is user-visible and can stop a run that previously completed. Neither changes
what a completed run measures, which is the question §3.1 asks.

### 3.2 The cost of a gratuitous protocol bump

`protocolVersion` is not free to move. `opensourcesai-cmdcenter` pins
`ACCEPTED_PROTOCOL_VERSIONS = ["osai-bench/1.3"]` and refuses anything else, so a bump makes every
new result unreadable there until that package is released. More fundamentally, it splits the
comparison corpus: §8.1's ladder cannot pool across it, and the population on each side of the
split is smaller than the one before it. A protocol bump that was not required by question 1 above
buys nothing and costs the corpus.

The converse error is worse. A measurement-semantics change shipped **without** a bump silently
pools incomparable records, and nothing downstream can detect it. When in genuine doubt, bump.

---

## 4. Evidence required for a protocol change

A protocol change is a change to the measurement contract and needs evidence, not reasoning.
None of the following is restated here — restating a threshold is how two copies of it start to
disagree — so each points at where it actually lives:

| Requirement | Where it is defined |
|---|---|
| Validity rules the change must not weaken | protocol §5.4 |
| Run-quality conditions | protocol §4 |
| Negative control: a knowingly broken configuration must score **materially worse** *and* fire the diagnostic for the fault it introduces | protocol §11 |
| Comparability of anything cross-machine | protocol §8.3, §8.4 |
| What has actually been validated, as opposed to what is in scope | [`coverage-v1.md`](coverage-v1.md) |

Additionally, a protocol change must:

- **State its rationale in the commit that makes it**, per CONTRIBUTING. The reasoning behind a
  measurement decision is the most valuable thing in this repository's history, and a protocol
  change with an unexplained rationale is unreviewable a year later.
- **Add or update a §13 changelog entry** naming what moved and what it means for existing records.
- **Be replayable.** Derivation must stay testable against committed fixtures with no GPU and no
  runtime present (§10). A change that can only be verified on live hardware is a change nobody can
  verify twice.

---

## 5. What stands between the protocol and a freeze

This is the checklist, and it is short because §12 items 2–6 are answered and stay answered.

| # | Blocker | Status |
|---|---|---|
| 1 | **§12.1 — the fixed prompts do not fit every model.** Four counterexamples in two mechanisms (§12.1a). Item 1 was closed and reopened by breadth | **Open. The one substantive protocol question** |
| 2 | **§4's contention threshold is provisional.** §4 requires a non-Ollama GPU-memory threshold but does not define one; the client uses a conservative 512 MiB and says in-line that it is provisional | **Open** |
| 3 | **W1/W2/W4 `num_ctx` and `keep_alive` are provisional.** §5.1 says `num_ctx` is per-workload; §5.2 gives no value for W1, W2 or W4, and the client picks 512/4096/4096 and marks each as a gap | **Open** |
| 4 | **W3's `num_ctx` of 4096 is a provisional starting assumption** (§12.5), though the same section establishes that W3's operating point sits on the prefill plateau | **Open, mitigated** |
| 5 | §11 negative control passes on real hardware, with the diagnostic firing | **Met** — §11.1–§11.4 |
| 6 | §12 items 2, 3, 4, 5, 6 answered | **Met** |

Blockers 2–4 share a shape: the spec requires a value and does not supply one, so the client picks
one and labels it. That is the honest interim state, and it is not a frozen contract — a value
nobody has ratified can be changed by anyone who thinks it is wrong, which is exactly what a freeze
is supposed to prevent. **Freezing v1 means ratifying these values or deriving better ones, not
deleting the word "provisional".**

Blocker 1 is different in kind: no choice of value fixes it. It needs a decision about what the
protocol does when a model's tokenizer cannot land inside a fixed band — accept the models it
fits and say so, or change the prompts and accept a new population. §12.1a records the evidence
and deliberately takes neither side.

---

## 6. After the freeze

- **Adding a device to the bandwidth table** is data, not protocol. It carries its own table
  version (`memoryBandwidthTableVersion`, recorded per result), so a record always names the table
  it used.
- **Adding a fixture** is evidence, and never changes a rule.
- **`coverage-v1.md` keeps moving**, because coverage is a record of what has been validated and
  that grows independently of the contract.
- **A defect in the client that produced wrong numbers** is a `clientVersion` fix, plus — if any
  published record is affected — a changelog entry saying which records and why. Silently fixing a
  measurement defect while leaving affected records unmarked is the one thing this scheme exists to
  make impossible.
- **v2, if it happens, does not invalidate v1 records.** They remain valid measurements under a
  named contract, and stay unpoolable with v2 records for the same reason `osai-bench/1`, `1.1` and
  `1.2` are unpoolable with each other today.

---

## 7. Out of this repository's scope

Issue #14 also asks for *contributor-facing instructions ready for the launch hub*. The hub is a
website surface and is not built here. What this repository owns and keeps current is: installation
and run instructions plus what is written to disk (README), the measurement contract
(`protocol-v1.md`), what has been validated (`coverage-v1.md`), the rules for changing any of it
(this document), and the working conventions for contributing (CONTRIBUTING.md). A launch hub
should link these rather than paraphrase them — a paraphrase of a measurement contract is a second
copy of it, and the two will disagree.
