# Bend 2 law contract — SVG absolute M/C/Z structural parser

> **Research-stage draft, not a checked proof or runtime change.** This file establishes a human-reviewable specification before anyone generates Bend implementations or `PROOF.bend`. Parent issue: https://github.com/Xpl4iN/VEC/issues/1 .

## Inspected implementation boundaries
- `packages/core/pipeline_ext/deloop.py`
- `packages/core/pipeline/pipeline.py`
- `packages/core/tests/test_selfintersect.py`

## Proposed human-owned laws
### L1: Full-input grammar acceptance

**Contract:** Accepted inputs consume all tokens and consist only of absolute M followed by one or more complete C segments and Z.

**Constraints / counterexamples:** Nonfinite coordinates and unparsed tails reject.

### L2: Serializer structural roundtrip

**Contract:** For every valid parsed segment list, parse(emit(segments)) preserves number/order of subpaths and cubic-control values under a chosen canonical numeric encoding.

**Constraints / counterexamples:** Define canonical numeric rendering and permitted coordinate range; avoid claiming unbounded float equality.

### L3: Fail closed on unknown geometry

**Contract:** Unsupported path grammar cannot produce a trustworthy 'no self-intersection' verdict.

**Constraints / counterexamples:** Geometry checks using NumPy approximations remain algorithmic tests, not formally proved Bend geometry.


## Proof scope and assumptions

Only structural parser. Bend 2 F32 properties are not provable, and the existing SciPy/skimage native pipeline should not be migrated.

## Agent implementation protocol

1. Treat this document and the linked issue as **human-owned acceptance criteria**. An AI agent may propose law changes, but cannot relax them without an independently reviewed change.
2. Extract a minimal **pure** model from the source paths above, with explicitly validated preconditions and small finite enums / bounded integer quantities where practical. Do not introduce external I/O or use `@unsafe` to obtain a proof.
3. On a subsequent implementation branch create `proofs/bend/LAWS.bend` (the reviewed claims), `proofs/bend/model.bend` (the actual algorithm), and `proofs/bend/PROOF.bend` (proof definitions). The implementation agent edits model/proof, **not** approved laws.
4. Run `bend proofs/bend/PROOF.bend --verdict` using a pinned Bend 2 release. Accept only `ALL PROOFS CHECK` with no admitted/unsafe/foreign proof shortcuts. Avoid publishing private code to BendHub.
5. Differential-test the resulting Bend model against the original TypeScript/Python code across all finite states and generated sequences or integer-domain fixtures. Retain every existing unit, integration and database guard test. Check for model-vs-production drift in CI before considering execution of generated JS.
6. Do **not** replace production logic merely because the model proves. Require a separate reviewed migration/cutover PR and demonstrate equivalent runtime behavior, input validation, error behavior and observability.

**Existing verification to preserve:** Run `pytest packages/core/tests`; preserve all numerical geometry regression fixtures.

## Definition of done (not yet met)

- [ ] Invariants reviewed and formalized as well-typed `law` definitions.
- [ ] Proofs pass the Bend kernel verdict.
- [ ] Differential tests run against production implementation and model.
- [ ] Agent policy prevents automatic weakening of laws / required verification.
- [ ] CI gates and the runtime trust boundary are documented and reviewed.
- [ ] A human explicitly approves (or declines) production migration.

## References

- [Bend 2 Guide — laws, proofs, verdict and JS interoperability](https://github.com/bendlang/bend/blob/main/guide/GUIDE.md)
- [Bend 2 README — limitations and trust boundaries](https://github.com/bendlang/bend/blob/main/README.md)
