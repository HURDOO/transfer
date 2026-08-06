import type {
  CreateLiveSessionResponse,
  JoinLiveSessionResponse,
  LiveIceCandidate,
  LiveIceServer,
  LiveSignal,
} from "../shared/contracts";
import {
  ApiClientError,
  closeLiveSession,
  pollLiveSignals,
  postLiveSignal,
} from "./api";
import {
  LIVE_BUFFER_HIGH_WATER_MARK_BYTES,
  LIVE_BUFFER_LOW_WATER_MARK_BYTES,
  LIVE_CHUNK_BYTES,
  LivePayloadAssembler,
  createLiveTransferPlan,
  parseLiveControl,
  serializeLiveControl,
  type LiveReceivedPayload,
  type LiveTransferPlan,
} from "./live-transfer-protocol";

const SIGNAL_POLL_INTERVAL_MS = 750;
const CONNECTION_TIMEOUT_MS = 30_000;
const BUFFER_DRAIN_TIMEOUT_MS = 30_000;
const RECEIVER_CLOSE_GRACE_MS = 2_000;
const CHANNEL_NAME = "move-it-live-v1";

export type LiveSenderStatus =
  "waiting" | "connecting" | "sending" | "confirming" | "sent";

export type LiveReceiverStatus = "connecting" | "receiving" | "received";

export interface LiveTransferProgress {
  loadedBytes: number;
  totalBytes: number;
  currentFileName: string | null;
}

interface LivePeerCallbacks<TStatus extends string> {
  onStatus: (status: TStatus) => void;
  onProgress: (progress: LiveTransferProgress) => void;
  onError: (message: string) => void;
}

interface LiveReceiverCallbacks extends LivePeerCallbacks<LiveReceiverStatus> {
  onPayload: (payload: LiveReceivedPayload) => void;
}

export interface LivePeerController {
  stop: () => void;
  cancel: () => void;
}

export function startLiveSender(
  session: CreateLiveSessionResponse,
  input: { text: string; files: File[] },
  callbacks: LivePeerCallbacks<LiveSenderStatus>,
): LivePeerController {
  const abortController = new AbortController();
  let connection: RTCPeerConnection | null = null;
  let dataChannel: RTCDataChannel | null = null;
  let cursor = 0;
  let completed = false;
  let failed = false;
  let plan: LiveTransferPlan;
  const pendingCandidates: RTCIceCandidateInit[] = [];

  try {
    plan = createLiveTransferPlan(input.text, input.files);
  } catch (error) {
    callbacks.onError(toLiveErrorMessage(error));
    return inertController();
  }

  callbacks.onStatus("waiting");
  callbacks.onProgress({
    loadedBytes: 0,
    totalBytes: plan.manifest.totalBytes,
    currentFileName: null,
  });

  const fail = (error: unknown) => {
    if (failed || completed || abortController.signal.aborted) return;
    failed = true;
    callbacks.onError(toLiveErrorMessage(error));
    teardown(abortController, dataChannel, connection);
    void closeLiveSession(session.code, session.senderToken);
  };

  const sendSignal = async (signal: Parameters<typeof postLiveSignal>[2]) => {
    await postLiveSignal(
      session.code,
      session.senderToken,
      signal,
      abortController.signal,
    );
  };

  const ensureConnection = async () => {
    if (connection) return;
    assertWebRtcSupport();

    callbacks.onStatus("connecting");
    connection = createPeerConnection(
      session.iceServers,
      sendSignal,
      fail,
      abortController.signal,
    );
    dataChannel = connection.createDataChannel(CHANNEL_NAME, { ordered: true });
    configureDataChannel(dataChannel);
    dataChannel.addEventListener("open", () => {
      if (!dataChannel || dataChannel.readyState !== "open") return;
      void streamLiveTransferPlan(
        dataChannel,
        plan,
        abortController.signal,
        callbacks,
      ).catch(fail);
    });
    dataChannel.addEventListener("message", (event) => {
      const message = parseLiveControl(event.data);
      if (message?.type === "cancel") {
        fail(new Error(message.reason || "받는 사람이 전송을 취소했어요."));
        return;
      }
      if (message?.type !== "received") return;
      completed = true;
      callbacks.onStatus("sent");
      void closeLiveSession(session.code, session.senderToken);
      window.setTimeout(
        () => teardown(abortController, dataChannel, connection),
        250,
      );
    });
    dataChannel.addEventListener("error", () => {
      fail(new Error("실시간 전송 채널에 문제가 생겼어요."));
    });

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    const localDescription = connection.localDescription;
    if (!localDescription || localDescription.type !== "offer") {
      throw new Error("실시간 연결 제안을 만들지 못했어요.");
    }
    await sendSignal({
      type: "description",
      description: { type: "offer", sdp: localDescription.sdp },
    });
  };

  const handleSignal = async (signal: LiveSignal) => {
    if (signal.type === "peer-ready") {
      await ensureConnection();
      return;
    }
    if (!connection) {
      throw new Error("상대 기기와 연결 순서가 맞지 않아요.");
    }
    if (signal.type === "description") {
      if (signal.description.type !== "answer") {
        throw new Error("예상하지 못한 연결 응답이에요.");
      }
      await connection.setRemoteDescription(signal.description);
      await flushCandidates(connection, pendingCandidates);
      return;
    }
    await addOrQueueCandidate(connection, pendingCandidates, signal.candidate);
  };

  void pollLoop(
    session.code,
    session.senderToken,
    abortController.signal,
    () => cursor,
    (nextCursor) => {
      cursor = nextCursor;
    },
    handleSignal,
  ).catch(fail);

  const stop = (notifyPeer: boolean) => {
    if (abortController.signal.aborted) return;
    if (notifyPeer && !completed) {
      sendCancel(dataChannel, "보내는 사람이 전송을 취소했어요.");
    }
    teardown(abortController, dataChannel, connection);
    if (!completed) void closeLiveSession(session.code, session.senderToken);
  };

  return {
    stop: () => stop(true),
    cancel: () => stop(true),
  };
}

export function startLiveReceiver(
  session: JoinLiveSessionResponse,
  callbacks: LiveReceiverCallbacks,
): LivePeerController {
  const abortController = new AbortController();
  const assembler = new LivePayloadAssembler();
  let connection: RTCPeerConnection | null = null;
  let dataChannel: RTCDataChannel | null = null;
  let cursor = 0;
  let completed = false;
  let failed = false;
  let currentFileName: string | null = null;
  let lastProgressAt = 0;
  const fileNames = new Map<string, string>();
  let receiveQueue = Promise.resolve();
  const pendingCandidates: RTCIceCandidateInit[] = [];

  callbacks.onStatus("connecting");
  callbacks.onProgress({
    loadedBytes: 0,
    totalBytes: 0,
    currentFileName: null,
  });

  const fail = (error: unknown) => {
    if (failed || completed || abortController.signal.aborted) return;
    failed = true;
    callbacks.onError(toLiveErrorMessage(error));
    sendCancel(dataChannel, "받는 기기에서 전송을 끝내지 못했어요.");
    teardown(abortController, dataChannel, connection);
    void closeLiveSession(session.code, session.receiverToken);
  };

  const sendSignal = async (signal: Parameters<typeof postLiveSignal>[2]) => {
    await postLiveSignal(
      session.code,
      session.receiverToken,
      signal,
      abortController.signal,
    );
  };

  try {
    assertWebRtcSupport();
    connection = createPeerConnection(
      session.iceServers,
      sendSignal,
      fail,
      abortController.signal,
    );
    connection.addEventListener("datachannel", (event) => {
      if (event.channel.label !== CHANNEL_NAME) {
        event.channel.close();
        return;
      }
      dataChannel = event.channel;
      configureDataChannel(dataChannel);
      dataChannel.addEventListener("open", () =>
        callbacks.onStatus("receiving"),
      );
      dataChannel.addEventListener("message", (messageEvent) => {
        receiveQueue = receiveQueue
          .then(async () => {
            const value = await normalizeDataChannelMessage(messageEvent.data);
            const control =
              typeof value === "string" ? parseLiveControl(value) : null;
            if (control?.type === "file-start") {
              currentFileName = fileNames.get(control.id) ?? control.id;
            }
            const result = assembler.accept(value);
            if (result.type === "cancel") {
              throw new Error(
                result.reason || "보내는 사람이 전송을 취소했어요.",
              );
            }
            if (result.type === "progress") {
              if (control?.type === "manifest" && control.files.length > 0) {
                control.files.forEach((file) =>
                  fileNames.set(file.id, file.name),
                );
                currentFileName = control.files[0]?.name ?? null;
              }
              const now = performance.now();
              if (
                result.loadedBytes === result.totalBytes ||
                now - lastProgressAt >= 100
              ) {
                lastProgressAt = now;
                callbacks.onProgress({
                  loadedBytes: result.loadedBytes,
                  totalBytes: result.totalBytes,
                  currentFileName,
                });
              }
              return;
            }
            if (result.type !== "complete") return;
            completed = true;
            callbacks.onPayload(result.payload);
            callbacks.onProgress({
              loadedBytes: result.payload.totalBytes,
              totalBytes: result.payload.totalBytes,
              currentFileName: null,
            });
            callbacks.onStatus("received");
            if (dataChannel?.readyState === "open") {
              dataChannel.send(
                serializeLiveControl({ version: 1, type: "received" }),
              );
            }
            window.setTimeout(() => {
              void closeLiveSession(session.code, session.receiverToken).catch(
                () => undefined,
              );
            }, RECEIVER_CLOSE_GRACE_MS);
            window.setTimeout(
              () => teardown(abortController, dataChannel, connection),
              500,
            );
          })
          .catch(fail);
      });
      dataChannel.addEventListener("error", () => {
        fail(new Error("실시간 수신 채널에 문제가 생겼어요."));
      });
    });
  } catch (error) {
    fail(error);
  }

  const handleSignal = async (signal: LiveSignal) => {
    if (!connection) {
      throw new Error("실시간 연결을 시작하지 못했어요.");
    }
    if (signal.type === "peer-ready") return;
    if (signal.type === "description") {
      if (signal.description.type !== "offer") {
        throw new Error("예상하지 못한 연결 요청이에요.");
      }
      await connection.setRemoteDescription(signal.description);
      await flushCandidates(connection, pendingCandidates);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      const localDescription = connection.localDescription;
      if (!localDescription || localDescription.type !== "answer") {
        throw new Error("실시간 연결 응답을 만들지 못했어요.");
      }
      await sendSignal({
        type: "description",
        description: { type: "answer", sdp: localDescription.sdp },
      });
      return;
    }
    await addOrQueueCandidate(connection, pendingCandidates, signal.candidate);
  };

  void pollLoop(
    session.code,
    session.receiverToken,
    abortController.signal,
    () => cursor,
    (nextCursor) => {
      cursor = nextCursor;
    },
    handleSignal,
  ).catch(fail);

  const stop = (notifyPeer: boolean) => {
    if (abortController.signal.aborted) return;
    if (notifyPeer && !completed) {
      sendCancel(dataChannel, "받는 사람이 전송을 취소했어요.");
    }
    teardown(abortController, dataChannel, connection);
    if (!completed) void closeLiveSession(session.code, session.receiverToken);
  };

  return {
    stop: () => stop(true),
    cancel: () => stop(true),
  };
}

export async function streamLiveTransferPlan(
  channel: RTCDataChannel,
  plan: LiveTransferPlan,
  signal: AbortSignal,
  callbacks: LivePeerCallbacks<LiveSenderStatus>,
): Promise<void> {
  callbacks.onStatus("sending");
  channel.send(serializeLiveControl(plan.manifest));
  let loadedBytes =
    plan.manifest.text === null
      ? 0
      : new TextEncoder().encode(plan.manifest.text).byteLength;
  callbacks.onProgress({
    loadedBytes,
    totalBytes: plan.manifest.totalBytes,
    currentFileName: plan.files[0]?.manifest.name ?? null,
  });
  let lastProgressAt = performance.now();

  for (const entry of plan.files) {
    ensureChannelOpen(channel, signal);
    channel.send(
      serializeLiveControl({
        version: 1,
        type: "file-start",
        id: entry.manifest.id,
      }),
    );
    for (let offset = 0; offset < entry.file.size; offset += LIVE_CHUNK_BYTES) {
      await waitForChannelBuffer(channel, signal);
      const chunk = await entry.file
        .slice(offset, Math.min(offset + LIVE_CHUNK_BYTES, entry.file.size))
        .arrayBuffer();
      ensureChannelOpen(channel, signal);
      channel.send(chunk);
      loadedBytes += chunk.byteLength;
      const now = performance.now();
      if (
        loadedBytes === plan.manifest.totalBytes ||
        now - lastProgressAt >= 100
      ) {
        lastProgressAt = now;
        callbacks.onProgress({
          loadedBytes,
          totalBytes: plan.manifest.totalBytes,
          currentFileName: entry.manifest.name,
        });
      }
    }
    channel.send(
      serializeLiveControl({
        version: 1,
        type: "file-end",
        id: entry.manifest.id,
      }),
    );
  }
  channel.send(serializeLiveControl({ version: 1, type: "complete" }));
  callbacks.onStatus("confirming");
}

function createPeerConnection(
  iceServers: LiveIceServer[],
  sendSignal: (signal: Parameters<typeof postLiveSignal>[2]) => Promise<void>,
  fail: (error: unknown) => void,
  abortSignal: AbortSignal,
): RTCPeerConnection {
  const connection = new RTCPeerConnection({
    iceServers: iceServers.map((server) => ({ ...server })),
  });
  let connected = false;
  const timeout = window.setTimeout(() => {
    if (!connected && !abortSignal.aborted) {
      fail(new Error("30초 안에 기기끼리 연결하지 못했어요."));
    }
  }, CONNECTION_TIMEOUT_MS);
  const clearConnectionTimeout = () => window.clearTimeout(timeout);
  abortSignal.addEventListener("abort", clearConnectionTimeout, { once: true });
  connection.addEventListener("connectionstatechange", () => {
    if (connection.connectionState === "connected") {
      connected = true;
      clearConnectionTimeout();
    } else if (connection.connectionState === "failed") {
      clearConnectionTimeout();
      fail(new Error("기기끼리 직접 연결하지 못했어요."));
    }
  });
  connection.addEventListener("icecandidate", (event) => {
    if (!event.candidate || abortSignal.aborted) return;
    void sendSignal({
      type: "candidate",
      candidate: toLiveIceCandidate(event.candidate),
    }).catch(fail);
  });
  return connection;
}

function configureDataChannel(channel: RTCDataChannel): void {
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = LIVE_BUFFER_LOW_WATER_MARK_BYTES;
}

function waitForChannelBuffer(
  channel: RTCDataChannel,
  signal: AbortSignal,
): Promise<void> {
  ensureChannelOpen(channel, signal);
  if (
    channel.bufferedAmount + LIVE_CHUNK_BYTES <=
    LIVE_BUFFER_HIGH_WATER_MARK_BYTES
  ) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onLow = () => finish();
    const onClose = () => finish(new Error("실시간 전송 채널이 닫혔어요."));
    const onAbort = () => finish(new DOMException("Aborted", "AbortError"));
    const timeout = window.setTimeout(
      () => finish(new Error("상대 기기가 데이터를 받지 못하고 있어요.")),
      BUFFER_DRAIN_TIMEOUT_MS,
    );
    channel.addEventListener("bufferedamountlow", onLow, { once: true });
    channel.addEventListener("close", onClose, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function ensureChannelOpen(channel: RTCDataChannel, signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (channel.readyState !== "open") {
    throw new Error("실시간 전송 채널이 닫혔어요.");
  }
}

function sendCancel(channel: RTCDataChannel | null, reason: string): void {
  if (channel?.readyState !== "open") return;
  try {
    channel.send(serializeLiveControl({ version: 1, type: "cancel", reason }));
  } catch {
    // Closing the local connection is still enough when the channel disappeared.
  }
}

function teardown(
  abortController: AbortController,
  channel: RTCDataChannel | null,
  connection: RTCPeerConnection | null,
): void {
  abortController.abort();
  channel?.close();
  connection?.close();
}

async function pollLoop(
  code: string,
  token: string,
  abortSignal: AbortSignal,
  getCursor: () => number,
  setCursor: (cursor: number) => void,
  handleSignal: (signal: LiveSignal) => Promise<void>,
): Promise<void> {
  while (!abortSignal.aborted) {
    const response = await pollLiveSignals(
      code,
      token,
      getCursor(),
      abortSignal,
    );
    for (const message of response.messages) {
      await handleSignal(message.signal);
      setCursor(Math.max(getCursor(), message.sequence));
    }
    await wait(SIGNAL_POLL_INTERVAL_MS, abortSignal);
  }
}

async function addOrQueueCandidate(
  connection: RTCPeerConnection,
  pending: RTCIceCandidateInit[],
  candidate: LiveIceCandidate,
): Promise<void> {
  if (!connection.remoteDescription) {
    pending.push(candidate);
    return;
  }
  await connection.addIceCandidate(candidate);
}

async function flushCandidates(
  connection: RTCPeerConnection,
  pending: RTCIceCandidateInit[],
): Promise<void> {
  for (const candidate of pending.splice(0)) {
    await connection.addIceCandidate(candidate);
  }
}

function toLiveIceCandidate(candidate: RTCIceCandidate): LiveIceCandidate {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  };
}

async function normalizeDataChannelMessage(
  value: string | Blob | ArrayBuffer,
): Promise<string | ArrayBuffer> {
  if (value instanceof Blob) return value.arrayBuffer();
  return value;
}

function assertWebRtcSupport(): void {
  if (!("RTCPeerConnection" in window)) {
    throw new Error("이 브라우저는 실시간 전송을 지원하지 않아요.");
  }
}

function inertController(): LivePeerController {
  return { stop: () => undefined, cancel: () => undefined };
}

function toLiveErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "실시간 전송을 취소했어요.";
  }
  if (error instanceof ApiClientError || error instanceof Error) {
    return error.message;
  }
  return "실시간 연결에 문제가 생겼어요. 다시 시도해 주세요.";
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
