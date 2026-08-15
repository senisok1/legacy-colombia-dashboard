import { addDays, formatISO, subDays } from "date-fns";
import type { Booking, Guest, Property, Review } from "./types";

// Realistic sample data so the dashboard is fully explorable before you connect
// a real OwnerRez Personal Access Token. None of this is written anywhere or
// sent to OwnerRez — it's generated fresh each time the server starts.

const today = new Date();
const iso = (d: Date) => formatISO(d, { representation: "date" });

export const demoProperty: Property = {
  id: 1,
  name: "Legacy Colombia",
  address: "Carrera 1 #2-3",
  city: "Medellín",
  state: "Antioquia",
  country: "Colombia",
  active: true,
};

export const demoGuests: Guest[] = [
  { id: 101, firstName: "Sarah", lastName: "Mitchell", fullName: "Sarah Mitchell", email: "sarah.mitchell@example.com", phone: "+1-555-0142", country: "United States" },
  { id: 102, firstName: "Diego", lastName: "Restrepo", fullName: "Diego Restrepo", email: "diego.restrepo@example.com", phone: "+57-300-555-1122", country: "Colombia" },
  { id: 103, firstName: "Lena", lastName: "Fischer", fullName: "Lena Fischer", email: "lena.fischer@example.com", phone: "+49-151-5550-9911", country: "Germany" },
  { id: 104, firstName: "Marcus", lastName: "Johnson", fullName: "Marcus Johnson", email: "marcus.johnson@example.com", phone: "+1-555-0198", country: "United States" },
  { id: 105, firstName: "Camila", lastName: "Torres", fullName: "Camila Torres", email: "camila.torres@example.com", phone: "+57-311-555-4433", country: "Colombia" },
  { id: 106, firstName: "Sarah", lastName: "Mitchell", fullName: "Sarah Mitchell", email: "sarah.mitchell@example.com", phone: "+1-555-0142", country: "United States" }, // repeat guest, same person different booking
];

function booking(
  id: number,
  guestId: number,
  arrivalOffset: number,
  nights: number,
  status: Booking["status"],
  source: string,
  nightlyRate: number,
  adults = 2,
  children = 0
): Booking {
  const arrival = addDays(today, arrivalOffset);
  const departure = addDays(arrival, nights);
  const total = nightlyRate * nights;
  const guest = demoGuests.find((g) => g.id === guestId);
  return {
    id,
    propertyId: demoProperty.id,
    propertyName: demoProperty.name,
    guestId,
    guestName: guest?.fullName,
    arrival: iso(arrival),
    departure: iso(departure),
    nights,
    status,
    source,
    adults,
    children,
    totalAmount: total,
    hostFee: Math.round(total * 0.03 * 100) / 100,
    payoutAmount: Math.round(total * 0.97 * 100) / 100,
    createdAt: iso(subDays(arrival, 30)),
    updatedAt: iso(subDays(arrival, 5)),
    isBlock: false,
    threadIds: [],
  };
}

export const demoBookings: Booking[] = [
  booking(9001, 104, -12, 5, "Checked Out", "Airbnb", 145),
  booking(9002, 105, -6, 3, "Checked Out", "Direct", 130),
  booking(9003, 101, -2, 4, "Checked In", "Vrbo", 150, 2, 1),
  booking(9004, 102, 1, 3, "Booked", "Airbnb", 140),
  booking(9005, 103, 6, 7, "Booked", "Booking.com", 135),
  booking(9006, 106, 20, 5, "Booked", "Airbnb", 160),
  booking(9007, 101, -60, 6, "Checked Out", "Airbnb", 138), // Sarah's earlier stay -> repeat guest
  booking(9008, 105, -40, 2, "Cancelled", "Direct", 130),
  booking(9009, 104, 35, 4, "Hold", "Vrbo", 155),
];

export const demoReviews: Review[] = [
  { id: 501, bookingId: 9001, guestName: "Marcus Johnson", source: "Airbnb", rating: 5, comment: "Beautiful place, incredible views, host was very responsive.", createdAt: iso(subDays(today, 6)) },
  { id: 502, bookingId: 9002, guestName: "Camila Torres", source: "Direct", rating: 5, comment: "Perfect for our family trip, would book again.", createdAt: iso(subDays(today, 2)) },
  { id: 503, bookingId: 9007, guestName: "Sarah Mitchell", source: "Airbnb", rating: 4, comment: "Great stay overall, WiFi was a bit spotty.", createdAt: iso(subDays(today, 55)) },
];
