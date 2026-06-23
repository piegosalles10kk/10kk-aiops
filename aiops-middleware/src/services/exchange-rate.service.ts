import axios from "axios";

let cachedRate: number | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 300_000;

export async function getUsdToBrl(): Promise<number> {
  const now = Date.now();
  if (cachedRate !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedRate;
  }
  try {
    const { data } = await axios.get<{
      USDBRL: { bid: string };
    }>("https://economia.awesomeapi.com.br/json/last/USD-BRL", {
      timeout: 10_000,
    });
    cachedRate = parseFloat(data.USDBRL.bid);
    cachedAt = now;
    return cachedRate;
  } catch {
    if (cachedRate !== null) return cachedRate;
    return 5.0;
  }
}

export async function convertUsdToBrl(usd: number): Promise<number> {
  const rate = await getUsdToBrl();
  return usd * rate;
}
