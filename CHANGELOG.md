# Changelog

All notable changes to `@vorq-ai/client-sdk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

Semver, with two points spelled out:

- **`0.x` means the public surface can change in a minor release.** The surface is exactly
  what `@vorq-ai/client-sdk` exports.
- **Deep imports are not covered at any version.** Reaching past the package's exports into
  `dist/` is reaching into an implementation.

Prereleases are published under the `next` dist-tag.

## [0.1.0-rc.2] — 2026-10-07

### Changed

- **Breaking:** `rateIn` / `rateOut` on `submit` are now `maxRateIn` / `maxRateOut`, and
  `rate_in` / `rate_out` on batch lines and in the `vorq` block of `sealingFetch` are now
  `max_rate_in` / `max_rate_out`. The old names are not accepted.
- The two are ceilings: an order signs the ask of the first provider within them and never
  more. Each is optional, and a side left out has no ceiling.
- An order no provider is within rests at its ceilings. With one ceiling named, the other side
  rests at the market rate, the cheapest live ask's. It used to be signed as zero, which no
  provider claims.
- An order with ceilings and no `provider` is matched to a provider when one is within them;
  it used to rest as an open order regardless.
- Every batch line is planned within its ceilings before sealing; `providers` spreads only the
  lines that rest, and a batch needs a `verifier` only when a line would rest open.
- **Breaking:** `sealLine` requires `rateIn` and `rateOut`: the rates the order signs.

## [0.1.0-rc.1] — 2026-10-01

Initial public release.
