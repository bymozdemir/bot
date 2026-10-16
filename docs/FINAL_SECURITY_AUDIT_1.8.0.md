# 1.8.0 Final Security / Live-Money Audit

## Release gate

- Automated tests: **374 / 374 PASS**
- JavaScript syntax check: **PASS**
- Secret-in-log static scan: **PASS**
- Direct eval / shell execution scan: **PASS** (no dynamic eval or shell-string execution found)
- Live trading remains explicitly gated by environment and exchange capability checks.

## Critical fixes in 1.8.0

### UNKNOWN entry recovery
If a market BUY was accepted by the exchange but the HTTP response was lost, recovery now:

1. reconciles the original `clientOrderId`;
2. recognizes the real FILLED result;
3. reconstructs the local position and accounting;
4. restores the configured protective order;
5. performs account reconciliation again;
6. opens the live trading gate only after protection is verified.

The bot never sends a second BUY for the same client order.

### Protective-order ownership recovery
If an exchange-side protective SELL exists but the local position does not know its ID, recovery may adopt it only when the match is unique and the quantity is consistent. Multiple ambiguous protective orders are treated as a safety lock; a new SELL is not created.

### OCO recovery
OCO positions persist their protection configuration. Recovery requires both protective legs to be identifiable when an OCO is expected. A single unexplained leg does not cause the bot to create another leg.

### Malformed exchange responses
Open-order endpoints now reject malformed successful HTTP responses instead of silently converting them to an empty order list. This prevents `HTTP 200 + invalid JSON/schema` from being interpreted as "there are no open orders".

### Candle validation
Live strategy evaluation rejects non-finite OHLCV values, invalid OHLC relationships, duplicate/backwards timestamps, inconsistent candle spacing and a timeframe that does not match the configured timeframe.

### Open-order limit
A portfolio-level `maxOpenOrders` setting is enforced both before new entries and during reconciliation. Default: `12`.

### Rate-limit handling
Network retry handling now honors `Retry-After` for 429/418 responses and applies bounded backoff/jitter. Mutating signed requests remain non-retryable when their outcome may be unknown.

## Exchange safety status

- **Binance:** strongest supported live adapter, but production remains behind the explicit `ALLOW_PRODUCTION_TRADING=true` gate.
- **Binance TR:** supported only after its explicit live gate and API contract verification; no native trailing assumption.
- **BTCTurk:** supported only after its explicit live gate and real-account contract verification; no OCO/trailing assumption.
- **Paribu:** deliberately remains blocked for live trading in this release because deterministic client-order identity and market-order-book safety are not sufficiently verified in the adapter.

## Important operational rule

A passing automated test suite does **not** prove an exchange API contract is correct in production. Before first real-money use, perform a controlled exchange-by-exchange contract test: balance read, symbol rules, open-order read, tiny controlled order, order query, cancellation/reconciliation and protective-order verification.

## Dependency lock note

The source package intentionally retains its dependency declarations. A `package-lock.json` could not be generated inside this build environment because outbound DNS/network access to the npm registry was unavailable. Do not claim dependency reproducibility until a lockfile has been generated with `npm install` in a networked build environment and committed together with this source.
