-- Per-organization secondary display currency (Settings > Currency). Lets a
-- tenant turn on a USD/<currency> toggle (see CurrencyProvider.tsx) that
-- converts every dollar figure across the dashboard using a live FX rate —
-- purely a display-layer conversion, nothing stored ever changes currency.
-- Defaults to null (feature off) for every org, since real-time FX
-- conversion is a premium convenience, not something every tenant needs.
-- Added 2026-08-05: turned on for Legacy Estate Rentals (Seni's own login)
-- with 'COP', since that's the tenant actually billing guests in both USD
-- and Colombian pesos (see Nukak #19 Bill Pay import). Other paid tenants
-- can enable their own secondary currency from Settings once they need it.

alter table organizations add column if not exists secondary_currency text;

update organizations set secondary_currency = 'COP' where slug = 'legacy-estate-rentals';
