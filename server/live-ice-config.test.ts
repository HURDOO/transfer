import { describe, expect, it } from "vitest";

import { parseLiveIceServers } from "./live-ice-config.js";

describe("parseLiveIceServers", () => {
  it("uses no external ICE service by default", () => {
    expect(parseLiveIceServers(undefined)).toEqual([]);
    expect(parseLiveIceServers("  ")).toEqual([]);
  });

  it("accepts STUN and credentialed TURN configuration", () => {
    expect(
      parseLiveIceServers(
        JSON.stringify([
          { urls: "stun:stun.example.com:3478" },
          {
            urls: [
              "turn:turn.example.com:3478?transport=udp",
              "turns:turn.example.com:5349?transport=tcp",
            ],
            username: "user",
            credential: "secret",
          },
        ]),
      ),
    ).toEqual([
      { urls: "stun:stun.example.com:3478" },
      {
        urls: [
          "turn:turn.example.com:3478?transport=udp",
          "turns:turn.example.com:5349?transport=tcp",
        ],
        username: "user",
        credential: "secret",
      },
    ]);
  });

  it.each([
    "not-json",
    JSON.stringify({ urls: "stun:stun.example.com" }),
    JSON.stringify([{ urls: "https://example.com" }]),
    JSON.stringify([{ urls: "turn:turn.example.com", username: "user" }]),
  ])("rejects unsafe or incomplete configuration: %s", (value) => {
    expect(() => parseLiveIceServers(value)).toThrow();
  });
});
