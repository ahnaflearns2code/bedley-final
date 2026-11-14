
export interface PlaceResult {
  placeId: string;
  name: string;
  address?: string;
  phone?: string;
  website?: string;
  rating?: number;
  reviews?: number;
  lat?: number;
  lng?: number;
  distanceKm?: number;
  source: "google_places";
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Google Places API (New) Text Search. Returns real businesses only — never invented. */
export async function searchPlaces(query: string, near: { lat: number; lng: number }, max = 5): Promise<{ ok: boolean; results: PlaceResult[]; error?: string }> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return { ok: false, results: [], error: "GOOGLE_PLACES_API_KEY not set" };
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.location",
      },
      body: JSON.stringify({
        textQuery: query,
        maxResultCount: max,
        locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 15000 } },
      }),
    });
    if (!res.ok) return { ok: false, results: [], error: `Places API ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = (await res.json()) as { places?: Array<Record<string, any>> };
    const results = (data.places || []).map((p) => {
      const loc = p.location ? { lat: p.location.latitude, lng: p.location.longitude } : undefined;
      return {
        placeId: p.id,
        name: p.displayName?.text ?? "Unknown",
        address: p.formattedAddress,
        phone: p.internationalPhoneNumber || p.nationalPhoneNumber,
        website: p.websiteUri,
        rating: p.rating,
        reviews: p.userRatingCount,
        lat: loc?.lat,
        lng: loc?.lng,
        distanceKm: loc ? Math.round(haversineKm(near, loc) * 10) / 10 : undefined,
        source: "google_places" as const,
      };
    });
    return { ok: true, results };
  } catch (e) {
    return { ok: false, results: [], error: (e as Error).message };
  }
}
