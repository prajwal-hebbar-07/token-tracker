export const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export const preciseMoney = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
export const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
export const fullNumber = new Intl.NumberFormat("en-US");
export const hiddenModels: Record<string, true> = {
  "claude-opus-4-8": true,
  "kimi-k2.7-code": true,
};

// Models the importer prices from published rates because the provider billed
// nothing. Mirrors ESTIMATED_PRICES in apps/api/src/db.ts.
export const estimatedModels: Record<string, true> = {
  "minimax-m3": true,
  "kimi-k2.6": true,
  "kimi-k3": true,
};

// Zero cost with tokens spent means the provider charged nothing; a null price
// means the model has no priced usage at all. They are not the same thing.
export function priceLabel(price: number | null): { value: string; caption: string } {
  if (price === null) return { value: "—", caption: "not priced yet" };
  if (price === 0) return { value: "Free", caption: "no recorded cost" };
  return { value: preciseMoney.format(price), caption: "per 1M tokens" };
}

export async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const payload: unknown = await response.json();
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
      message = payload.error;
    }
    throw new Error(message);
  }
  return payload;
}
