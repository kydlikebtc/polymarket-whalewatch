import { z } from "zod";
export const TradeSchema = z.object({
  proxyWallet: z.string(),
  side: z.enum(["BUY", "SELL"]),
  asset: z.string(),
  conditionId: z.string(),
  size: z.number(),
  price: z.number(),
  timestamp: z.number(),
  title: z.string(),
  slug: z.string(),
  eventSlug: z.string(),
  outcome: z.string(),
  outcomeIndex: z.number(),
  transactionHash: z.string(),
});
export type Trade = z.infer<typeof TradeSchema>;
