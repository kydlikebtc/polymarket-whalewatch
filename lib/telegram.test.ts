import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendMessage } from "./telegram";
beforeEach(() => vi.restoreAllMocks());
describe("sendMessage", () => {
  it("POSTs to the bot sendMessage endpoint with HTML parse_mode", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await sendMessage({ botToken: "T", chatId: "@c" }, "hello");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/botT/sendMessage");
    expect(JSON.parse(init.body).parse_mode).toBe("HTML");
    expect(JSON.parse(init.body).chat_id).toBe("@c");
  });
});
