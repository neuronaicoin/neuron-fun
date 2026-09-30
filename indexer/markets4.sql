-- All coins, clean-up (update-77): remove what isn't a meme coin (wrapped
-- coins, stablecoins, staked ETH) and tokens with broken market data (market
-- value in the trillions), which the collector now skips. Safe to run again.

delete from ext_tokens
 where coalesce(fdv_usd, 0) >= 1e13
    or coalesce(mcap_usd, 0) >= 1e13
    or name ~* '\mwrapped\M'
    or name ~* '\mstable ?coin\M'
    or upper(symbol) ~ 'USD'
    or upper(symbol) ~ '^W(ETH|BTC|BNB|SOL|AVAX|POL|MATIC|S)$'
    or upper(symbol) ~ '^(ST|WST|WE|EZ|R|CB|S|M|OS)ETH$';

-- Values over $1T that are left are unknown, not real.
update ext_tokens set fdv_usd = null where fdv_usd >= 1e12;
update ext_tokens set mcap_usd = null where mcap_usd >= 1e12;
