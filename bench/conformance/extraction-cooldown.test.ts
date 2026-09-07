// Conformance test for the failed-extraction cooldown feature. Shipped by the
// bench; both benchmark arms must make this file pass WITHOUT editing it.
import { describe, test, expect, setSystemTime } from "bun:test";
import { createStreamingModule } from "../../streaming/module.js";
import { createHlsProxy } from "../../streaming/hls-proxy.js";
import { InMemoryStreamUrlStore } from "../../streaming/index.js";
import {
  StubProvider,
  createStubEvent,
  StubRemoteFetcher,
  MultiProviderEventRepository,
} from "./stubs.js";
import {
  PPV_FOOTBALL_CONTENT_ID,
  TEST_ADDON_URL,
  TEST_STREAM_URL,
  TEST_REFERER,
} from "./fixtures.js";
import { EXTRACTION_COOLDOWN_MS } from "../../config/constants.js";
import type { StreamingConfig } from "../../streaming/types.js";

const config: StreamingConfig = {
  addonUrl: TEST_ADDON_URL,
  extractionTimeoutMs: 35000,
};

function createTestModule(
  streamResult: { url: string; referer: string } | null,
  calls: { count: number } = { count: 0 },
) {
  const provider = new StubProvider({
    id: "ppv",
    events: [createStubEvent()],
    extractStream: async () => {
      calls.count += 1;
      return streamResult;
    },
  });
  return createStreamingModule(config, {
    providers: new MultiProviderEventRepository([provider]),
    streamStore: new InMemoryStreamUrlStore(),
    proxy: createHlsProxy(
      { m3u8CacheTtlMs: 30000, segmentCacheMaxPerEvent: 30, segmentCacheMaxEvents: 5 },
      new StubRemoteFetcher(),
    ),
  });
}

describe("extraction cooldown conformance", () => {
  test("EXTRACTION_COOLDOWN_MS is 5 minutes", () => {
    expect(EXTRACTION_COOLDOWN_MS).toBe(5 * 60 * 1000);
  });

  test("failed extraction is attempted, then suppressed within cooldown", async () => {
    const calls = { count: 0 };
    const streaming = createTestModule(null, calls);

    const first = await streaming.getStreams(PPV_FOOTBALL_CONTENT_ID, "key");
    expect(first).toHaveLength(0);
    expect(calls.count).toBe(1);

    const second = await streaming.getStreams(PPV_FOOTBALL_CONTENT_ID, "key");
    expect(second).toHaveLength(0);
    expect(calls.count).toBe(1);
  });

  test("cooldown expires lazily and extraction is retried", async () => {
    const calls = { count: 0 };
    const streaming = createTestModule(null, calls);

    await streaming.getStreams(PPV_FOOTBALL_CONTENT_ID, "key");
    expect(calls.count).toBe(1);

    setSystemTime(Date.now() + EXTRACTION_COOLDOWN_MS + 1000);
    try {
      await streaming.getStreams(PPV_FOOTBALL_CONTENT_ID, "key");
      expect(calls.count).toBe(2);
    } finally {
      setSystemTime(Date.now());
    }
  });

  test("successful extractions are unaffected by the cooldown", async () => {
    const calls = { count: 0 };
    const streaming = createTestModule(
      { url: TEST_STREAM_URL, referer: TEST_REFERER },
      calls,
    );

    const first = await streaming.getStreams(PPV_FOOTBALL_CONTENT_ID, "key");
    expect(first).toHaveLength(1);
    expect(calls.count).toBe(1);

    const second = await streaming.getStreams(PPV_FOOTBALL_CONTENT_ID, "key");
    expect(second).toHaveLength(1);
    expect(second[0].url).toContain("/proxy/stream/");
    expect(calls.count).toBe(1);
  });

  test("cooldown state is per module instance (in-memory only)", async () => {
    const callsA = { count: 0 };
    const a = createTestModule(null, callsA);
    await a.getStreams(PPV_FOOTBALL_CONTENT_ID, "key");
    expect(callsA.count).toBe(1);

    const callsB = { count: 0 };
    const b = createTestModule(null, callsB);
    await b.getStreams(PPV_FOOTBALL_CONTENT_ID, "key");
    expect(callsB.count).toBe(1);
  });
});
