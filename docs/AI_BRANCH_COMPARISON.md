# AI branch comparison — master selection

## Selected base

`1.5.1-robust-walkforward` is the selected master codebase.

The reviewed archives share the same core architecture and mostly represent successive branches rather than independent products. The selection was therefore made by feature-level comparison, not by version number or file count.

## Why 1.5.1 wins

- Superset of the earlier Paper/Shadow/Live, recovery, reconciliation, risk and deployment work.
- Adds automated strategy search with combination strategies.
- Adds walk-forward train/validation/blind-OOS controls and robustness scoring.
- Retains explicit order-rule validation and exchange-specific live safety gates.
- Retains per-installation `BOT_DATA_DIR` isolation for state and encrypted credentials.
- Retains Paribu live safety gate and fingerprint-recovery path.
- Retains ATR/Stochastic indicators introduced by later strategy-search work.
- Retains the broader regression suite; 290 tests pass in this selected branch.

## Important comparison findings

### 11 / 11-multi-exchange

The 11-multi-exchange branch contains useful exchange-side changes, but the selected 1.5.1 branch already contains the stronger versions of the important ones:

- Binance / Binance TR stop-limit handling is present.
- BTCTurk quote-amount market-buy handling is preserved.
- Exchange rule validation is stricter in 1.5.1; unknown/missing minimum rules do not silently become safe defaults.
- Fingerprint recovery is preserved where client order IDs are unavailable.
- Paribu has private API scaffolding, recovery and live safety gating rather than being reduced to ticker-only support.

The 11-multi-exchange branch was also tested independently: 277/277 tests passed, but it removes several safety/feature paths that exist in 1.5.1.

### 1.0–1.4

These branches were treated as historical sources. Their useful additions are already represented in the selected tree, including:

- API preflight and offline safety checks
- Paper/Shadow/Live separation
- recovery/reconciliation
- portable Docker/VPS deployment
- per-installation isolation
- technical indicators and risk center groundwork

Independent regression checks also passed for 1.0.0-v2 (282/282) and 1.4.0 (284/284).

## Deliberate non-merges

Code was not copied merely because it was newer, longer, or present in another branch. In particular, safety-critical exchange behavior that weakens validation or substitutes fabricated defaults was rejected.

## Real-world limitation

No branch has been treated as real-exchange verified. API credentials were not used and no live order was submitted during this comparison. Exchange behavior still requires controlled external verification before LIVE is enabled.

## Archive note

The uploaded `crypto-bot (1).zip` remained unreadable as a ZIP archive in the runtime; it was not used to override conclusions from the valid archives. Re-uploading it as a valid ZIP would allow an additional comparison pass.
