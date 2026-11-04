import type { OversightCounts } from "@nexus/shared";
import { fetchJson } from "../../lib/api-transport";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

/**
 * The governance counts, scoped on the server to what this caller may read.
 *
 * A separate module from the panel so the panel can be tested against fake
 * data without also faking the transport — and so the URL lives in one place
 * when a second screen inevitably wants the same numbers.
 */
export async function getOversightCounts(): Promise<OversightCounts> {
  return fetchJson<OversightCounts>(`${apiUrl}/api/oversight`, {
    cache: "no-store"
  });
}
