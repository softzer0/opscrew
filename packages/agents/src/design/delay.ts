import { listText } from "@opscrew/core";
import type { CloudProvider } from "@opscrew/plan-schema";

/**
 * Where a server is, for the delay estimate: a cloud location, or a server the user owns, whose
 * location OpsCrew does not know.
 */
export type ServerPlace = { provider: "own" } | { provider: CloudProvider; location: string };

/**
 * Latitude and longitude (degrees) of each location the providers offer: Hetzner's data centres
 * and DigitalOcean's regions, by the city they are in.
 */
const LOCATIONS: Readonly<
  Record<CloudProvider, Readonly<Record<string, readonly [number, number]>>>
> = {
  hetzner: {
    fsn1: [50.4779, 12.3713],
    nbg1: [49.4521, 11.0767],
    hel1: [60.1699, 24.9384],
    ash: [39.0438, -77.4874],
    hil: [45.5229, -122.9898],
    sin: [1.3521, 103.8198],
  },
  digitalocean: {
    nyc1: [40.7128, -74.006],
    nyc2: [40.7128, -74.006],
    nyc3: [40.7128, -74.006],
    sfo2: [37.7749, -122.4194],
    sfo3: [37.7749, -122.4194],
    tor1: [43.6532, -79.3832],
    atl1: [33.749, -84.388],
    ric1: [37.5407, -77.436],
    mkc1: [39.0997, -94.5786],
    mem1: [35.1495, -90.049],
    ams3: [52.3676, 4.9041],
    lon1: [51.5074, -0.1278],
    fra1: [50.1109, 8.6821],
    sgp1: [1.3521, 103.8198],
    blr1: [12.9716, 77.5946],
    syd1: [-33.8688, 151.2093],
  },
};

/** Above this estimated round trip (ms), a page making many queries in a row slows noticeably. */
export const DELAY_WARNING_MS = 5;

/** The queries in a row of the page the estimate describes. */
export const PAGE_QUERIES = 20;

/** The base of every hop (ms): WireGuard and the two servers' network stacks (research R5b). */
const BASE_MS = 2;
/** Real routes run about twice the straight line: 1 ms of round trip per 50 km of it (R5b). */
const KM_PER_MS = 50;
const EARTH_RADIUS_KM = 6371;

/** A cloud place's coordinates, when OpsCrew knows them. */
function coordinates(place: ServerPlace): readonly [number, number] | undefined {
  return place.provider === "own" ? undefined : LOCATIONS[place.provider][place.location];
}

/** The great-circle distance between two points (haversine), in km. */
function distanceKm(a: readonly [number, number], b: readonly [number, number]): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const h =
    Math.sin(rad(b[0] - a[0]) / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** A hop's estimated round trip, from the two places' great-circle distance. */
export interface HopEstimate {
  /** `2 ms + distance / 50 km` (research R5b), unrounded. */
  roundTripMs: number;
  distanceKm: number;
}

/**
 * The estimated round trip of a query between two places: 2 ms plus 1 ms per 50 km of their
 * great-circle distance, calibrated on two Hetzner servers (fsn1 to hel1: about 28 ms estimated,
 * 36 ms measured). `undefined` when either place is unknown: a server the user owns, or a location
 * the table lacks.
 */
export function estimateHop(a: ServerPlace, b: ServerPlace): HopEstimate | undefined {
  const from = coordinates(a);
  const to = coordinates(b);
  if (from === undefined || to === undefined) return undefined;
  const km = distanceKm(from, to);
  return { roundTripMs: BASE_MS + km / KM_PER_MS, distanceKm: km };
}

/** What design says about the hop from the app's server to the services on another server. */
export interface HopDelay {
  /** The estimate, when both places are known. */
  estimate?: HopEstimate;
  /** What the hop adds to a page making {@link PAGE_QUERIES} queries in a row (ms), rounded. */
  pageMs?: number;
  /** One plain sentence: the estimate and what it adds to a page, or that `opscrew status` measures it. */
  text: string;
  /** Set above {@link DELAY_WARNING_MS}: why it matters and what would shorten it. */
  warning?: string;
}

/** `fsn1` or `your own server`. */
function placeName(place: ServerPlace): string {
  return place.provider === "own" ? "your own server" : place.location;
}

/**
 * The delay each query from the app to `services` on the server `server` (at `place`) adds, from
 * the app's server at `app` ({@link estimateHop}), labelled as an estimate, with what it adds to a
 * page making {@link PAGE_QUERIES} queries in a row, and a warning above {@link DELAY_WARNING_MS}.
 * When it cannot be estimated (a server the user owns), the sentence says `opscrew status` measures
 * it.
 */
export function hopDelay(
  app: ServerPlace,
  server: string,
  place: ServerPlace,
  services: readonly string[],
): HopDelay {
  const to = `${listText(services)} on server ${server}`;
  const estimate = estimateHop(app, place);
  if (estimate === undefined) {
    const unknown = [app, place]
      .filter((p) => coordinates(p) === undefined)
      .map((p) => (p.provider === "own" ? "your own server's location" : p.location));
    return {
      text: `OpsCrew cannot estimate the delay of each query from the app to ${to}: it does not know ${listText([...new Set(unknown)])}. \`opscrew status\` measures it once the servers are linked.`,
    };
  }
  const ms = Math.round(estimate.roundTripMs);
  const pageMs = Math.round(estimate.roundTripMs * PAGE_QUERIES);
  const km = Math.round(estimate.distanceKm).toLocaleString("en-US");
  const text = `Each query from the app to ${to} waits about ${ms} ms (an estimate: 2 ms plus 1 ms per 50 km between ${placeName(app)} and ${placeName(place)}, ${km} km apart), so a page that makes ${PAGE_QUERIES} queries in a row takes about ${pageMs} ms longer.`;
  if (estimate.roundTripMs <= DELAY_WARNING_MS) return { estimate, pageMs, text };
  return {
    estimate,
    pageMs,
    text,
    warning: `Each query from the app to ${to} waits about ${ms} ms, so a page that makes ${PAGE_QUERIES} queries in a row takes about ${pageMs} ms longer, which users notice. To shorten it, put server ${server} in ${placeName(app)} with the app's server (about ${BASE_MS} ms a query), or keep ${listText(services)} on the app's server.`,
  };
}
