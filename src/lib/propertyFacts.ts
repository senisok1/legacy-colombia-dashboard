// Ground-truth facts about the property, used to keep the AI guest-reply
// drafter (see lib/aiReply.ts) from guessing or inventing details.
//
// Primary source: the live Airbnb listing —
// https://www.airbnb.com/rooms/1076161346460191053 (captured 2026-07-28).
// This is a static snapshot, not a live fetch — if the listing changes
// (new amenities, policy changes, pricing, etc.), update the text below to
// match. Booking-specific facts (arrival/departure dates, guest count,
// thread) come from the OwnerRez Booking record itself, not from this file.

export const PROPERTY_FACTS = `
Property: "Legacy Colombia Luxury Waterfront Wellness Retreat" — an entire
waterfront villa in Peñol, Antioquia, Colombia. Listed on Airbnb, 4.98
average rating (84 reviews), Guest Favorite / Top 10% of homes, hosted by
Superhosts Carolina y Ana Escobar (Gutierrez Group) with co-hosts Ana Maria
and Geo. Host typically responds within an hour (95% response rate).

Basics:
- Sleeps 18 guests comfortably (listing header also shows "16+ guests").
- 4 large high-end en-suite bedrooms (2 are Master Bedrooms), 9 beds total,
  4.5 bathrooms.
  - Bedroom 1: 1 king bed + 1 trundle bed
  - Bedroom 2: 1 king bed + 1 trundle bed
  - Bedroom 3: 1 bunk bed + 1 trundle bed
  - (Bedroom 4 not itemized in the listing's bed breakdown)
- Set on 2+ private acres, gated private compound, with 1,000–1,500+ feet of
  direct waterfront/lakefront access and a private dock.
- Starlink high-speed WiFi across the entire 2-acre property.

House rules:
- Check-in after 3:00 PM. Checkout before 10:00 AM.
- Quiet hours 11:00 PM – 7:00 AM.
- Pets allowed.
- No parties or events without prior approval; approved events may require
  on-site property management supervision.
- Guests must register with passports via a link sent before check-in
  (property registration #259071) — required to enter the house.
- Colombian residents are subject to an additional 19% tax on the
  reservation cost; they'll be contacted about this once the reservation is
  confirmed.

Amenities:
- Indoor fireplace; open, spacious indoor-outdoor living area.
- High-end chef's kitchen: oven, microwave, large stove, premium appliances,
  spacious dining/bar area.
- Outdoor kitchen + BBQ area for lakeside dining.
- Private jacuzzi.
- Barrel sauna + ice bath contrast therapy.
- Optional professionally chilled cold plunge (below 50°F) — $95 per stay,
  requires 24-hour advance notice.
- State-of-the-art gym + outdoor fitness playground.
- Large dock suitable for group yoga or gatherings.
- Private tennis court.
- Kayaking and swimming directly from the private dock/lakefront.
- Seasonal fruit trees and herbs throughout the estate, free for guests to
  use in the kitchen.
- Multiple outdoor lounge areas.
- Mountain view, lake view, waterfront.
- No smoke alarm on the property; exterior security cameras are present;
  pool/hot tub area does not have a gate or lock — worth mentioning
  proactively to families with small children if it comes up.

Optional paid experiences ("Enhance Your Stay" menu — sourced directly from
Seni, updated 2026-07-30). These prices ARE verified facts and may be quoted
directly when a guest asks about any of them. Each also has a bit of color
Seni wants used (not just the bare price) when replying:
- Traditional Colombian Private Chef: $20 USD per person, per meal, plus the
  cost of groceries. Authentic Colombian cuisine prepared in the villa —
  this is the best traditional private chef in Peñol/Guatapé, guests are
  consistently impressed.
- Upscale VIP Private Chef: custom quote based on menu, group size, and
  preferences — a luxury fine-dining experience with one of the area's
  premier private chefs. Don't invent a number for this one; say it's a
  custom quote.
- In-Home Massage: 180,000 COP per person for a 60-minute massage, in the
  villa — these are the best in-home private massage therapists in
  Peñol/Guatapé.
- Jet Ski Rentals: 300,000 COP per jet ski, per hour — top-of-the-line jet
  skis delivered right to the villa's backyard dock.
- Private Pontoon Boat Rental: 300,000 COP per hour, max 15 guests —
  convenient pick-up and drop-off for the pontoon outing right on the
  villa's backyard dock, great for sightseeing, swimming, or just enjoying
  the lake with the group.
- Professionally Chilled Cold Plunge: $95 USD per stay, maintained below
  50°F (10°C), available throughout the stay, requires 24-hour advance
  notice to prepare.
- Curated local recommendations (dining, excursions, culture, family
  activities), birthday/special-occasion celebration setups, and
  transportation arrangements are also available — no fixed public pricing,
  quote on request.

If a guest asks about any of the above (including anything not explicitly
listed but clearly in the same category — spa/wellness treatments, boat or
watercraft rentals, private chef/dining, local transportation, etc.), the
reply should: (1) quote the specific price above if one is listed for what
they asked, weaving in that service's bit of color naturally rather than
just stating a flat number, or say it's a custom quote if no price is
listed, and (2) assume they want to book it — don't say "if you're
interested"; say Seni is going ahead and connecting them with Gabriel, the
on-site property manager, over WhatsApp right now so he can coordinate the
details and make sure everything's ready for their stay. Gabriel handles
the actual booking/scheduling for these — the reply itself should not
attempt to confirm a specific date/time.

Location:
- About a 2-minute drive on a private paved road from the main highway.
- Roughly under an hour from Medellín (MDE) airport; about 15 minutes from
  Plazoleta de los Zócalos.
- Exact address: Parcelación NUKAK, Peñol, Antioquia, Colombia. Map:
  https://www.google.com/maps/place/Parcelaci%C3%B3n+NUKAK/@6.2164322,-75.2307011,17z
  (provided by Seni 2026-07-30).
  HOST POLICY, ENFORCE STRICTLY: guests are not given the exact address/map
  link until the day of their check-in. If a guest asks for the address, the
  street/pin location, or "the actual address of the house" before their
  arrival date, do NOT share it — instead say the exact address and arrival
  instructions are sent on the day of check-in, and that the general
  location/area is as described above in the meantime. Only include the
  address itself in the reply if the guest's arrival date (given in the
  booking context) is today or has already passed. When it's appropriate to
  share it, give the address plainly; the map link is for your/Gabriel's
  reference and doesn't need to be pasted into the guest reply unless asked
  for something to click.

What this file intentionally does NOT cover (don't guess — say you'll
confirm, or leave it out): the exact nightly rate/quote for their specific
dates, security/damage deposit amount, cleaning fee, wifi password, and gate
or door access codes. Those either vary per booking or need Seni to confirm
directly — if a guest asks about one of them, the drafted reply should say
so honestly rather than inventing a number. (The exact address is now a
known fact above, but is still gated by the check-in-day policy — see
Location.)
`.trim();
