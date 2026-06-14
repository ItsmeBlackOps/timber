// "Docs match the API surface" (spec §8.4). Asserts the in-app Query API
// reference (DOCUMENTED_ENDPOINTS) covers exactly the real server surface
// described by the independent fixture (test/fixtures/api-surface.fixture).
//
// Failure modes this catches:
//   - a server endpoint added without a docs entry  -> "documented endpoints …"
//   - a docs endpoint that no longer exists          -> same
//   - a param added/removed on an endpoint           -> per-endpoint param diff
//   - an auth flag drift                             -> per-endpoint auth check
import { DOCUMENTED_ENDPOINTS } from "@/content/docs/api-surface";
import { API_SURFACE } from "../../../test/fixtures/api-surface.fixture";

function sortedParams(params: string[]): string[] {
  return [...params].sort();
}

describe("docs match the real API surface", () => {
  it("documents exactly the endpoints the server exposes", () => {
    const documented = DOCUMENTED_ENDPOINTS.map((e) => e.path).sort();
    const real = API_SURFACE.map((e) => e.path).sort();
    expect(documented).toEqual(real);
  });

  it("covers all six query-API + health endpoints", () => {
    const documented = new Set(DOCUMENTED_ENDPOINTS.map((e) => e.path));
    for (const path of [
      "/v1/logs",
      "/v1/stats",
      "/v1/events",
      "/v1/facets",
      "/v1/groupby",
      "/healthz",
    ]) {
      expect(documented.has(path)).toBe(true);
    }
  });

  it("documents the exact param set for every endpoint", () => {
    const realByPath = new Map(API_SURFACE.map((e) => [e.path, e]));
    for (const doc of DOCUMENTED_ENDPOINTS) {
      const real = realByPath.get(doc.path);
      expect(real, `no fixture entry for ${doc.path}`).toBeDefined();
      expect(
        sortedParams(doc.params),
        `param mismatch for ${doc.path}`,
      ).toEqual(sortedParams(real!.params));
    }
  });

  it("matches the auth requirement for every endpoint", () => {
    const realByPath = new Map(API_SURFACE.map((e) => [e.path, e]));
    for (const doc of DOCUMENTED_ENDPOINTS) {
      expect(doc.auth, `auth mismatch for ${doc.path}`).toBe(
        realByPath.get(doc.path)!.auth,
      );
    }
  });

  it("has no duplicate documented endpoints", () => {
    const paths = DOCUMENTED_ENDPOINTS.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("documents /healthz as the only no-auth endpoint", () => {
    const noAuth = DOCUMENTED_ENDPOINTS.filter((e) => !e.auth).map(
      (e) => e.path,
    );
    expect(noAuth).toEqual(["/healthz"]);
  });
});
