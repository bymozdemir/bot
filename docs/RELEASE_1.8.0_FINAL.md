# Crypto Bot 1.8.0 Final

This release is the hardened successor to 1.7.2-final-fixed2.

## Main changes

- Deterministic recovery of FILLED UNKNOWN entry orders.
- Automatic reconstruction of missing local positions from exchange-confirmed fills.
- Protective stop/OCO ownership recovery.
- Duplicate protective-order detection and fail-closed handling.
- Second reconciliation after recovery repair.
- Strict malformed open-order response rejection on supported adapters.
- Live candle OHLCV/timestamp/timeframe validation.
- Portfolio `maxOpenOrders` safety limit.
- HTTP 429/418 `Retry-After` handling with bounded backoff.
- 371 automated tests, including new red-team recovery scenarios.

## Live-money gate

This is a code-final release, not a declaration that all four exchanges are production-approved. Real-money activation remains intentionally gated per exchange and must be preceded by the controlled API contract protocol described in `docs/LIVE_API_SETUP.md` and `docs/FINAL_SECURITY_AUDIT_1.8.0.md`.
