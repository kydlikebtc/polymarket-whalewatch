import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import {
  ALERT_HITS_WINDOW_DAYS,
  parseAlertHit,
  queryAlertHitRows,
} from "./alertHits";

const ADDR = "0x00000000000000000000000000000000000000ab";
const NOW = 1_700_000_000;

const insert = (db: ReturnType<typeof openDb>) =>
  db.prepare(
    "INSERT INTO alerts (type, dedup_key, payload, created_at) VALUES (?, ?, ?, ?)",
  );

it("returns recent payload matches newest-first and excludes rows past the window", () => {
  const db = openDb(":memory:");
  const ins = insert(db);
  const payload = JSON.stringify({ proxyWallet: ADDR });
  ins.run("large", "k1", payload, NOW - 100);
  ins.run("smart", "k2", payload, NOW - 50);
  // Same wallet but older than the window — the created_at lower bound (the
  // thing that keeps the LIKE probe off a full-table scan) must exclude it.
  ins.run("large", "k3", payload, NOW - (ALERT_HITS_WINDOW_DAYS + 1) * 86_400);
  // In-window row for a DIFFERENT wallet — must not match the LIKE probe.
  ins.run("large", "k4", JSON.stringify({ proxyWallet: "0xother" }), NOW - 10);
  const rows = queryAlertHitRows(db, ADDR, { nowSec: NOW });
  expect(rows.map((r) => ({ type: r.type, created_at: r.created_at }))).toEqual(
    [
      { type: "smart", created_at: NOW - 50 },
      { type: "large", created_at: NOW - 100 },
    ],
  );
});

it("applies the row limit newest-first", () => {
  const db = openDb(":memory:");
  const ins = insert(db);
  for (let i = 0; i < 5; i++) {
    ins.run("large", `k${i}`, JSON.stringify({ proxyWallet: ADDR }), NOW - i);
  }
  const rows = queryAlertHitRows(db, ADDR, { nowSec: NOW, limit: 3 });
  expect(rows.map((r) => r.created_at)).toEqual([NOW, NOW - 1, NOW - 2]);
});

describe("parseAlertHit", () => {
  it("shapes a trade payload and keeps its eventSlug for the market link", () => {
    const hit = parseAlertHit({
      type: "large",
      created_at: NOW,
      payload: JSON.stringify({
        title: "Market A",
        outcome: "Yes",
        side: "BUY",
        size: 20000,
        price: 0.5,
        eventSlug: "market-a",
      }),
    });
    expect(hit).toEqual({
      type: "large",
      createdAt: NOW,
      title: "Market A",
      outcome: "Yes",
      side: "BUY",
      usd: 10000, // size × price
      price: 0.5,
      eventSlug: "market-a",
    });
  });

  it("falls back to the market slug, and to '' when neither slug exists (never 'undefined')", () => {
    const slugOnly = parseAlertHit({
      type: "large",
      created_at: NOW,
      payload: JSON.stringify({ title: "B", slug: "market-b" }),
    });
    expect(slugOnly?.eventSlug).toBe("market-b");
    const none = parseAlertHit({
      type: "large",
      created_at: NOW,
      payload: JSON.stringify({ title: "C" }),
    });
    expect(none?.eventSlug).toBe("");
  });

  it("consensus payloads map the group aggregate (BUY, totalNetUsd, no fill price)", () => {
    const hit = parseAlertHit({
      type: "consensus",
      created_at: NOW,
      payload: JSON.stringify({
        title: "Market D",
        outcome: "No",
        totalNetUsd: 12345,
        eventSlug: "market-d",
      }),
    });
    expect(hit).toEqual({
      type: "consensus",
      createdAt: NOW,
      title: "Market D",
      outcome: "No",
      side: "BUY",
      usd: 12345,
      price: null,
      eventSlug: "market-d",
    });
  });

  it("returns null for unparseable payloads", () => {
    expect(
      parseAlertHit({ type: "large", created_at: NOW, payload: "not json" }),
    ).toBeNull();
  });
});
