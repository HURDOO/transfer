import { describe, expect, it } from "vitest";

import type { LiveClientSignal } from "../shared/contracts.js";
import { LiveSessionStore } from "./live-session-store.js";

describe("LiveSessionStore", () => {
  it("routes peer-ready, offer, and answer signals only to the other peer", () => {
    const tokens = ["sender-token", "receiver-token"];
    const store = new LiveSessionStore({
      now: () => Date.UTC(2026, 7, 6, 0, 0, 0),
      createCode: () => "004201",
      createToken: () => tokens.shift()!,
    });

    const created = store.create();
    expect(created).toMatchObject({
      code: "004201",
      senderToken: "sender-token",
    });

    const joined = store.join("004201");
    expect(joined).toMatchObject({
      status: "joined",
      session: { receiverToken: "receiver-token" },
    });
    if (!created || joined.status !== "joined") {
      throw new Error("Expected a joined live session.");
    }

    const senderReady = store.poll("004201", created.senderToken, 0);
    expect(senderReady).toMatchObject({
      status: "ok",
      messages: [{ sequence: 1, signal: { type: "peer-ready" } }],
    });
    expect(store.poll("004201", joined.session.receiverToken, 0)).toMatchObject(
      {
        status: "ok",
        messages: [],
      },
    );

    const offer: LiveClientSignal = {
      type: "description",
      description: { type: "offer", sdp: "offer-sdp" },
    };
    expect(store.postSignal("004201", created.senderToken, offer)).toEqual({
      status: "ok",
    });
    expect(store.poll("004201", joined.session.receiverToken, 0)).toMatchObject(
      {
        status: "ok",
        messages: [{ sequence: 2, signal: offer }],
      },
    );

    const answer: LiveClientSignal = {
      type: "description",
      description: { type: "answer", sdp: "answer-sdp" },
    };
    expect(
      store.postSignal("004201", joined.session.receiverToken, answer),
    ).toEqual({ status: "ok" });
    expect(store.poll("004201", created.senderToken, 1)).toMatchObject({
      status: "ok",
      messages: [{ sequence: 3, signal: answer }],
    });
  });

  it("allows one receiver and hides sessions from invalid tokens", () => {
    const tokens = ["sender-token", "receiver-token"];
    const store = new LiveSessionStore({
      createCode: () => "123456",
      createToken: () => tokens.shift()!,
    });
    const created = store.create()!;

    expect(store.join(created.code).status).toBe("joined");
    expect(store.join(created.code)).toEqual({ status: "occupied" });
    expect(store.poll(created.code, "wrong-token", 0)).toEqual({
      status: "not-found",
    });
    expect(
      store.postSignal(created.code, "wrong-token", {
        type: "candidate",
        candidate: {
          candidate: "candidate:1",
          sdpMid: "0",
          sdpMLineIndex: 0,
          usernameFragment: null,
        },
      }),
    ).toEqual({ status: "not-found" });
    expect(store.close(created.code, "wrong-token")).toEqual({
      status: "not-found",
    });
    expect(store.close(created.code, created.senderToken)).toEqual({
      status: "ok",
    });
    expect(store.join(created.code)).toEqual({ status: "not-found" });
  });

  it("expires sessions without persistence and enforces the memory cap", () => {
    let now = 1_000;
    const codes = ["000001", "000002"];
    const store = new LiveSessionStore({
      now: () => now,
      ttlMs: 100,
      maxSessions: 1,
      createCode: () => codes.shift()!,
      createToken: () => "token",
    });

    const first = store.create();
    expect(first?.expiresAt).toBe(new Date(1_100).toISOString());
    expect(store.create()).toBeNull();

    now = 1_100;
    expect(store.cleanup()).toBe(1);
    expect(store.join("000001")).toEqual({ status: "not-found" });
    expect(store.create()?.code).toBe("000002");
  });

  it("skips codes reserved by an active stored share", () => {
    const codes = ["700001", "700002"];
    const store = new LiveSessionStore({
      createCode: () => codes.shift()!,
      createToken: () => "sender-token",
      isCodeUnavailable: (code) => code === "700001",
    });

    expect(store.create()?.code).toBe("700002");
    expect(store.hasActiveCode("700002")).toBe(true);
    expect(store.hasActiveCode("700001")).toBe(false);
  });

  it("bounds each peer signal queue while preserving recent sequence cursors", () => {
    const tokens = ["sender-token", "receiver-token"];
    const store = new LiveSessionStore({
      createCode: () => "555555",
      createToken: () => tokens.shift()!,
    });
    const created = store.create()!;
    const joined = store.join(created.code);
    if (joined.status !== "joined") {
      throw new Error("Expected a joined live session.");
    }

    for (let index = 0; index < 300; index += 1) {
      expect(
        store.postSignal(created.code, created.senderToken, {
          type: "candidate",
          candidate: {
            candidate: `candidate:${index}`,
            sdpMid: "0",
            sdpMLineIndex: 0,
            usernameFragment: null,
          },
        }),
      ).toEqual({ status: "ok" });
    }

    const result = store.poll(created.code, joined.session.receiverToken, 0);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.messages).toHaveLength(256);
    expect(result.messages[0]?.sequence).toBe(46);
    expect(result.messages.at(-1)?.sequence).toBe(301);
  });
});
