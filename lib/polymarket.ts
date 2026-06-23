import type { Trade } from "./types";
const DATA_API = "https://data-api.polymarket.com";
export async function getLargeTrades(
  minUsd: number,
  limit = 500,
): Promise<Trade[]> {
  const url = `${DATA_API}/trades?filterType=CASH&filterAmount=${minUsd}&takerOnly=true&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`getLargeTrades ${res.status}`);
  return (await res.json()) as Trade[];
}
