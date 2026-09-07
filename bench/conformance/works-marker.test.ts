// Conformance test for the "[WORKS]" marker feature. Shipped by the bench;
// both benchmark arms must make this file pass WITHOUT editing it.
import { describe, test, expect, setSystemTime } from "bun:test";
import { createStreamingModule } from "../../streaming/module.js";
import { createHlsProxy } from "../../streaming/hls-proxy.js";
import { InMemoryStreamUrlStore } from "../../streaming/index.js";
import {
  createPpvProvider,
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
import { buildCatalogResponse } from "../../utils/content-helpers.js";
import { WORKS_TTL_MS } from "../../config/constants.js";
import type { StreamingConfig } from "../../streaming/types.js";

const config: StreamingConfig = {
  addonUrl: TEST_ADDON_URL,
  extractionTimeoutMs: 35000,
};

function createTestModule(
  events = [createStubEvent()],
  streamResult: { url: string; referer: string } | null = {
    url: TEST_STREAM_URL,
    referer: TEST_REFERER,
  },
) {
  const provider = createPpvProvider({ events, streamResult });
  return createStreamingModule(config, {
    providers: new MultiProviderEventRepository([provider]),
    streamStore: new InMemoryStreamUrlStore(),
    proxy: createHlsProxy(
      { m3u8CacheTtlMs: 30000, segmentCacheMaxPerEvent: 30, segmentCacheMaxEvents: 5 },
      new StubRemoteFetcher(),
    ),
  });
}

describe("WORKS marker conformance", () => {
  test("WORKS_TTL_MS is 10 minutes", () => {
    expect(WORKS_TTL_MS).toBe(10 * 60 * 1000);
  });

  test("event is unmarked before extraction", () => {
    const streaming = createTestModule();
    expect(streaming.hasWorkingStream(PPV_FOOTBALL_CONTENT_ID)).toBe(false);
  });

  test("successful extraction marks the event", async () => {
    const streaming = createTestModule();
    const streams = await streaming.getStreams(PPV_FOOTBALL_CONTENT_ID, "key");
    expect(streams).toHaveLength(1);
    expect(streaming.hasWorkingStream(PPV_FOOTBALL_CONTENT_ID)).toBe(true);
  });

  test("failed extraction does not mark the event", async () => {
    const streaming = createTestModule([createStubEvent()], null);
    const streams = await streaming.getStreams(PPV_FOOTBALL_CONTENT_ID, "key");
    expect(streams).toHaveLength(0);
    expect(streaming.hasWorkingStream(PPV_FOOTBALL_CONTENT_ID)).toBe(false);
  });

  test("mark expires after 10 minutes", async () => {
    const start = Date.now();
    const streaming = createTestModule();
    await streaming.getStreams(PPV_FOOTBALL_CONTENT_ID, "key");
    expect(streaming.hasWorkingStream(PPV_FOOTBALL_CONTENT_ID)).toBe(true);
    setSystemTime(new Date(start + 10 * 60 * 1000 - 1000));
    expect(streaming.hasWorkingStream(PPV_FOOTBALL_CONTENT_ID)).toBe(true);
    setSystemTime(new Date(start + 10 * 60 * 1000 + 1000));
    expect(streaming.hasWorkingStream(PPV_FOOTBALL_CONTENT_ID)).toBe(false);
  });

  test("buildCatalogResponse composes [WORKS] before [LIVE]", () => {
    const event = createStubEvent();
    const isWorking = (id: string) => id === event.id;
    const metas = buildCatalogResponse([event], { isWorking });
    expect(metas[0].name.startsWith("[WORKS]")).toBe(true);
    const plain = buildCatalogResponse([event]);
    expect(plain[0].name.startsWith("[WORKS]")).toBe(false);
  });
});
