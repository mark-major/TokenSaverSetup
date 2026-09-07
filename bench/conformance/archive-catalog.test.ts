// Conformance test for the archive catalog feature. Shipped by the bench;
// both benchmark arms must make this file pass WITHOUT editing it.
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
import { TEST_ADDON_URL } from "./fixtures.js";
import { ARCHIVE_CATALOG_ID, EVENT_EXPIRY_BUFFER_S } from "../../config/constants.js";
import type { StreamingConfig } from "../../streaming/types.js";
import type { NormalizedEvent } from "../../providers/index.js";

const config: StreamingConfig = {
  addonUrl: TEST_ADDON_URL,
  extractionTimeoutMs: 35000,
};

function event(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return createStubEvent({ catalogs: ["Football"], ...overrides });
}

function createTestModule(events: NormalizedEvent[]) {
  const provider = new StubProvider({ id: "ppv", events });
  return createStreamingModule(config, {
    providers: new MultiProviderEventRepository([provider]),
    streamStore: new InMemoryStreamUrlStore(),
    proxy: createHlsProxy(
      { m3u8CacheTtlMs: 30000, segmentCacheMaxPerEvent: 30, segmentCacheMaxEvents: 5 },
      new StubRemoteFetcher(),
    ),
  });
}

const NOW = Date.now();
const live = event({
  id: "ppv_live_1",
  name: "Live Match",
  startTime: Math.floor(NOW / 1000) - 600,
  endTime: Math.floor(NOW / 1000) + 3600,
});
const recentlyEnded = event({
  id: "ppv_recent_1",
  name: "Recently Ended",
  startTime: Math.floor(NOW / 1000) - 7200,
  endTime: Math.floor(NOW / 1000) - 300, // within expiry buffer
});
const longEnded = event({
  id: "ppv_old_1",
  name: "Long Ended",
  startTime: Math.floor(NOW / 1000) - 40000,
  endTime: Math.floor(NOW / 1000) - 36000, // well past buffer
});

describe("archive catalog conformance", () => {
  test("ARCHIVE_CATALOG_ID is 'archive'", async () => {
    expect(ARCHIVE_CATALOG_ID).toBe("archive");
  });

  test("long-ended events leave their regular catalog", async () => {
    setSystemTime(NOW);
    try {
      const streaming = createTestModule([live, longEnded]);
      const football = await streaming.getCatalog("Football");
      expect(football.find((e) => e.id === "ppv_old_1")).toBeUndefined();
      expect(football.find((e) => e.id === "ppv_live_1")).toBeDefined();
    } finally {
      setSystemTime(Date.now());
    }
  });

  test("long-ended events appear in the archive catalog", async () => {
    setSystemTime(NOW);
    try {
      const streaming = createTestModule([live, longEnded]);
      const archive = await streaming.getCatalog(ARCHIVE_CATALOG_ID);
      expect(archive.find((e) => e.id === "ppv_old_1")).toBeDefined();
      expect(archive.find((e) => e.id === "ppv_live_1")).toBeUndefined();
    } finally {
      setSystemTime(Date.now());
    }
  });

  test("events within the expiry buffer stay in their regular catalog", async () => {
    setSystemTime(NOW);
    try {
      const streaming = createTestModule([live, recentlyEnded]);
      const football = await streaming.getCatalog("Football");
      expect(football.find((e) => e.id === "ppv_recent_1")).toBeDefined();
      const archive = await streaming.getCatalog(ARCHIVE_CATALOG_ID);
      expect(archive.find((e) => e.id === "ppv_recent_1")).toBeUndefined();
    } finally {
      setSystemTime(Date.now());
    }
  });

  test("expiry honours EVENT_EXPIRY_BUFFER_S", async () => {
    expect(EVENT_EXPIRY_BUFFER_S).toBeGreaterThan(0);
    setSystemTime(NOW);
    try {
      const streaming = createTestModule([longEnded]);
      // Advancing time must not change the outcome: longEnded stays archived.
      setSystemTime(NOW + 60_000);
      const archive = await streaming.getCatalog(ARCHIVE_CATALOG_ID);
      expect(archive.find((e) => e.id === "ppv_old_1")).toBeDefined();
    } finally {
      setSystemTime(Date.now());
    }
  });
});
