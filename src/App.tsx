import QRCode from "qrcode";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  MAX_FILES,
  MAX_SHARE_BYTES,
  MAX_TEXT_BYTES,
  type CreateLiveSessionResponse,
  type ExpirationValue,
  type ResolveCodeResponse,
  type ShareResponse,
} from "../shared/contracts";
import {
  ApiClientError,
  closeLiveSession,
  createLiveSession,
  createShare,
  getShare,
  joinLiveSession,
  resolveReceiveCode,
} from "./api";
import { formatBytes, formatDate } from "./format";
import {
  startLiveReceiver,
  startLiveSender,
  type LivePeerController,
  type LiveReceiverStatus,
  type LiveSenderStatus,
  type LiveTransferProgress,
} from "./live-transfer";
import {
  createLiveTransferPlan,
  type LiveReceivedPayload,
} from "./live-transfer-protocol";
import { getNextExpirationDelay, hasExpirationPassed } from "./expiration";

type Theme = "light" | "dark";
type HomeMode = "send" | "receive";
type ContentMode = "files" | "text";
type TransferMode = "stored" | "live";
type AppRoute =
  { kind: "stored"; code: string } | { kind: "live"; code: string } | null;

const EXPIRATION_OPTIONS: Array<{ value: ExpirationValue; label: string }> = [
  { value: "1h", label: "1시간" },
  { value: "1d", label: "1일" },
  { value: "3d", label: "3일" },
  { value: "7d", label: "1주일" },
  { value: "30d", label: "30일" },
  { value: "never", label: "만료 안 함" },
];

export default function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [homeMode, setHomeMode] = useState<HomeMode>("send");
  const [homeTransferMode, setHomeTransferMode] =
    useState<TransferMode>("stored");
  const [route, setRoute] = useState<AppRoute>(() =>
    parseRoute(window.location.pathname),
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("move-it-theme", theme);
    const themeColor = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    themeColor?.setAttribute(
      "content",
      theme === "dark" ? "#101214" : "#f7f8fa",
    );
  }, [theme]);

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (path: string) => {
    window.history.pushState({}, "", path);
    setRoute(parseRoute(path));
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  const navigateHome = (
    mode: HomeMode = "send",
    transferMode: TransferMode = "stored",
  ) => {
    setHomeMode(mode);
    setHomeTransferMode(transferMode);
    navigate("/");
  };

  return (
    <div className="app-shell">
      <Header
        theme={theme}
        onToggleTheme={() => setTheme(theme === "light" ? "dark" : "light")}
        onHome={() => navigateHome()}
      />
      <main>
        {route?.kind === "stored" ? (
          <ShareView
            key={`stored-${route.code}`}
            code={route.code}
            onReceiveAnother={() => navigateHome("receive", "stored")}
          />
        ) : route?.kind === "live" ? (
          <LiveReceiveView
            key={`live-${route.code}`}
            code={route.code}
            onReceiveAnother={() => navigateHome("receive", "live")}
          />
        ) : (
          <Home
            initialMode={homeMode}
            initialTransferMode={homeTransferMode}
            onReceive={({ code, kind }) =>
              navigate(kind === "live" ? `/live/${code}` : `/s/${code}`)
            }
          />
        )}
      </main>
      <footer className="site-footer">
        <span>내 서버에서, 필요한 만큼만.</span>
        <span aria-hidden="true">·</span>
        <span>최대 1GB</span>
      </footer>
    </div>
  );
}

function Header({
  theme,
  onToggleTheme,
  onHome,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  onHome: () => void;
}) {
  return (
    <header className="site-header">
      <div className="header-inner">
        <button className="wordmark" type="button" onClick={onHome}>
          <span className="wordmark-mark" aria-hidden="true">
            <ArrowUpRightIcon />
          </span>
          <span>옮기기</span>
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={onToggleTheme}
          aria-label={
            theme === "light" ? "어두운 화면으로 전환" : "밝은 화면으로 전환"
          }
        >
          {theme === "light" ? <MoonIcon /> : <SunIcon />}
        </button>
      </div>
    </header>
  );
}

function Home({
  initialMode,
  initialTransferMode,
  onReceive,
}: {
  initialMode: HomeMode;
  initialTransferMode: TransferMode;
  onReceive: (result: ResolveCodeResponse) => void;
}) {
  const [mode, setMode] = useState<HomeMode>(initialMode);
  const [transferMode, setTransferMode] =
    useState<TransferMode>(initialTransferMode);
  const [sendBusy, setSendBusy] = useState(false);
  const headingId =
    mode === "receive"
      ? "receive-heading"
      : transferMode === "live"
        ? "live-send-heading"
        : "send-heading";

  return (
    <section className="transfer-panel" aria-labelledby={headingId}>
      <div className="mode-switch" aria-label="보내기 또는 받기">
        <button
          type="button"
          className={mode === "send" ? "active" : ""}
          aria-pressed={mode === "send"}
          onClick={() => setMode("send")}
          disabled={sendBusy}
        >
          보내기
        </button>
        <button
          type="button"
          className={mode === "receive" ? "active" : ""}
          aria-pressed={mode === "receive"}
          onClick={() => setMode("receive")}
          disabled={sendBusy}
        >
          받기
        </button>
      </div>

      {mode === "send" && (
        <div className="delivery-switch" aria-label="전송 방식">
          <button
            type="button"
            className={transferMode === "stored" ? "active" : ""}
            aria-pressed={transferMode === "stored"}
            onClick={() => setTransferMode("stored")}
            disabled={sendBusy}
          >
            서버에 보관
          </button>
          <button
            type="button"
            className={transferMode === "live" ? "active" : ""}
            aria-pressed={transferMode === "live"}
            onClick={() => setTransferMode("live")}
            disabled={sendBusy}
          >
            실시간 연결
          </button>
        </div>
      )}

      <div hidden={mode !== "send"}>
        {transferMode === "stored" ? (
          <SendFlow onBusyChange={setSendBusy} />
        ) : (
          <LiveSendFlow onBusyChange={setSendBusy} />
        )}
      </div>
      <div hidden={mode !== "receive"}>
        <ReceiveForm active={mode === "receive"} onReceive={onReceive} />
      </div>
    </section>
  );
}

function SendFlow({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [contentMode, setContentMode] = useState<ContentMode>("files");
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [expiresIn, setExpiresIn] = useState<ExpirationValue>("1d");
  const [dragActive, setDragActive] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ShareResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<(() => void) | null>(null);

  const fileBytes = useMemo(
    () => files.reduce((total, file) => total + file.size, 0),
    [files],
  );
  const textBytes = useMemo(() => new Blob([text]).size, [text]);
  const totalBytes = fileBytes + textBytes;
  const itemCount = files.length + (text.trim().length > 0 ? 1 : 0);

  useEffect(
    () => () => {
      abortRef.current?.();
    },
    [],
  );

  const addFiles = (incoming: File[]) => {
    if (uploading) {
      return;
    }
    const merged = [...files, ...incoming];

    if (merged.length > MAX_FILES) {
      setError(`파일은 한 번에 최대 ${MAX_FILES}개까지 보낼 수 있어요.`);
      return;
    }
    const nextTotal =
      merged.reduce((total, file) => total + file.size, 0) + textBytes;
    if (nextTotal > MAX_SHARE_BYTES) {
      setError("한 번에 올릴 수 있는 용량은 1GB예요.");
      return;
    }
    setFiles(merged);
    setError(null);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragActive(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (itemCount === 0) {
      setError("파일을 고르거나 텍스트를 입력해 주세요.");
      return;
    }
    if (totalBytes > MAX_SHARE_BYTES) {
      setError("한 번에 올릴 수 있는 용량은 1GB예요.");
      return;
    }

    setUploading(true);
    onBusyChange(true);
    setProgress(0);
    setError(null);
    const operation = createShare({ files, text, expiresIn }, setProgress);
    abortRef.current = operation.abort;

    try {
      const share = await operation.promise;
      setResult(share);
    } catch (caught) {
      const message =
        caught instanceof ApiClientError
          ? caught.message
          : "공유를 만들지 못했어요. 다시 시도해 주세요.";
      setError(message);
    } finally {
      abortRef.current = null;
      setUploading(false);
      onBusyChange(false);
    }
  };

  const reset = () => {
    setFiles([]);
    setText("");
    setExpiresIn("1d");
    setProgress(0);
    setError(null);
    setResult(null);
    setContentMode("files");
  };

  if (result) {
    return <ShareResult key={result.code} share={result} onReset={reset} />;
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="panel-intro">
        <p className="eyebrow">빠르고 단순하게</p>
        <h1 id="send-heading">무엇을 옮길까요?</h1>
        <p>파일이나 텍스트를 올리면 바로 쓸 수 있는 6자리 코드가 생겨요.</p>
      </div>

      <div className="content-switch" aria-label="보낼 내용 종류">
        <button
          type="button"
          className={contentMode === "files" ? "active" : ""}
          aria-pressed={contentMode === "files"}
          onClick={() => setContentMode("files")}
          disabled={uploading}
        >
          <FileIcon />
          파일
          {files.length > 0 && (
            <span className="count-badge">{files.length}</span>
          )}
        </button>
        <button
          type="button"
          className={contentMode === "text" ? "active" : ""}
          aria-pressed={contentMode === "text"}
          onClick={() => setContentMode("text")}
          disabled={uploading}
        >
          <TextIcon />
          텍스트
          {text.trim().length > 0 && (
            <span className="status-dot" aria-label="입력됨" />
          )}
        </button>
      </div>

      {contentMode === "files" ? (
        <div className="content-area">
          <input
            ref={inputRef}
            id="file-input"
            className="sr-only"
            type="file"
            multiple
            onChange={onFileChange}
            disabled={uploading}
          />
          <label
            className={`dropzone${dragActive ? " drag-active" : ""}`}
            htmlFor="file-input"
            aria-disabled={uploading}
            onDragEnter={(event) => {
              event.preventDefault();
              if (!uploading) setDragActive(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              ) {
                setDragActive(false);
              }
            }}
            onDrop={onDrop}
          >
            <span className="dropzone-icon" aria-hidden="true">
              <PlusIcon />
            </span>
            <strong>{dragActive ? "여기에 놓으세요" : "파일 선택"}</strong>
            <span>여러 파일을 끌어다 놓아도 돼요</span>
          </label>

          {files.length > 0 && (
            <div className="selected-files" aria-label="선택한 파일">
              <div
                className="selection-summary"
                role="status"
                aria-live="polite"
              >
                <span>파일 {files.length}개</span>
                <span>{formatBytes(fileBytes)}</span>
              </div>
              <ul>
                {files.map((file, index) => (
                  <li
                    key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                  >
                    <span className="file-type-icon" aria-hidden="true">
                      <FileIcon />
                    </span>
                    <span className="file-details">
                      <span className="file-name">{file.name}</span>
                      <span className="file-size">
                        {formatBytes(file.size)}
                      </span>
                    </span>
                    <button
                      className="remove-button"
                      type="button"
                      aria-label={`${file.name} 삭제`}
                      onClick={() =>
                        setFiles(
                          files.filter((_, fileIndex) => fileIndex !== index),
                        )
                      }
                      disabled={uploading}
                    >
                      <CloseIcon />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="text-button"
                onClick={() => inputRef.current?.click()}
                disabled={uploading}
              >
                파일 더하기
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="content-area">
          <label className="text-label" htmlFor="share-text">
            보낼 텍스트
          </label>
          <textarea
            id="share-text"
            value={text}
            onChange={(event) => {
              const nextText = event.target.value;
              const nextTextBytes = new Blob([nextText]).size;
              if (nextTextBytes > MAX_TEXT_BYTES) {
                setError("텍스트는 최대 1MB까지 보낼 수 있어요.");
                return;
              }
              const nextBytes = nextTextBytes + fileBytes;
              if (nextBytes > MAX_SHARE_BYTES) {
                setError("한 번에 올릴 수 있는 용량은 1GB예요.");
                return;
              }
              setText(nextText);
              setError(null);
            }}
            placeholder="링크, 메모, 짧은 코드처럼 옮길 내용을 붙여 넣으세요."
            rows={8}
            disabled={uploading}
          />
          <div className="textarea-meta">
            <span>텍스트는 최대 1MB까지 보낼 수 있어요.</span>
            <span>{formatBytes(textBytes)}</span>
          </div>
        </div>
      )}

      <div className="form-divider" />

      <label className="field-label" htmlFor="expiration">
        <span>언제까지 열어둘까요?</span>
        <span className="field-hint">기본 1일</span>
      </label>
      <div className="select-wrap">
        <select
          id="expiration"
          value={expiresIn}
          onChange={(event) =>
            setExpiresIn(event.target.value as ExpirationValue)
          }
          disabled={uploading}
        >
          {EXPIRATION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon />
      </div>

      {itemCount > 0 && (
        <p className="send-summary" aria-live="polite">
          보낼 항목 {itemCount}개 · {formatBytes(totalBytes)}
        </p>
      )}

      {error && (
        <div className="inline-error" role="alert">
          <AlertIcon />
          <span>{error}</span>
        </div>
      )}

      {uploading && (
        <div className="upload-progress" aria-live="polite">
          <div className="progress-copy">
            <span>안전하게 올리는 중</span>
            <strong>{progress}%</strong>
          </div>
          <progress max="100" value={progress} aria-label="업로드 진행률">
            {progress}%
          </progress>
        </div>
      )}

      <div className="form-actions">
        <button className="primary-button" type="submit" disabled={uploading}>
          {uploading ? "올리는 중…" : "공유 코드 만들기"}
          {!uploading && <ArrowRightIcon />}
        </button>
        {uploading && (
          <button
            className="secondary-button"
            type="button"
            onClick={() => abortRef.current?.()}
          >
            취소
          </button>
        )}
      </div>
    </form>
  );
}

function LiveSendFlow({
  onBusyChange,
}: {
  onBusyChange: (busy: boolean) => void;
}) {
  const [contentMode, setContentMode] = useState<ContentMode>("files");
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transfer, setTransfer] = useState<{
    session: CreateLiveSessionResponse;
    text: string;
    files: File[];
  } | null>(null);
  const [status, setStatus] = useState<LiveSenderStatus>("waiting");
  const [completed, setCompleted] = useState(false);
  const [progress, setProgress] = useState<LiveTransferProgress>({
    loadedBytes: 0,
    totalBytes: 0,
    currentFileName: null,
  });
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<LivePeerController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileBytes = useMemo(
    () => files.reduce((total, file) => total + file.size, 0),
    [files],
  );
  const textBytes = useMemo(() => new Blob([text]).size, [text]);
  const totalBytes = fileBytes + textBytes;
  const itemCount = files.length + (text.trim().length > 0 ? 1 : 0);

  useEffect(() => {
    if (!transfer) return;
    const controller = startLiveSender(transfer.session, transfer, {
      onStatus: (nextStatus) => {
        setStatus(nextStatus);
        if (nextStatus === "sent") {
          setCompleted(true);
          setTransfer(null);
          setFiles([]);
          setText("");
          setError(null);
          onBusyChange(false);
        }
      },
      onProgress: setProgress,
      onError: setError,
    });
    controllerRef.current = controller;
    return () => {
      controller.stop();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [onBusyChange, transfer]);

  useEffect(
    () => () => {
      onBusyChange(false);
    },
    [onBusyChange],
  );

  const addFiles = (incoming: File[]) => {
    if (creating || transfer) return;
    const merged = [...files, ...incoming];
    if (merged.length > MAX_FILES) {
      setError(`파일은 한 번에 최대 ${MAX_FILES}개까지 보낼 수 있어요.`);
      return;
    }
    const nextTotal =
      merged.reduce((total, file) => total + file.size, 0) + textBytes;
    if (nextTotal > MAX_SHARE_BYTES) {
      setError("한 번에 옮길 수 있는 용량은 1GB예요.");
      return;
    }
    setFiles(merged);
    setError(null);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragActive(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      createLiveTransferPlan(text, files);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "보낼 파일이나 텍스트를 확인해 주세요.",
      );
      return;
    }

    setCreating(true);
    setError(null);
    onBusyChange(true);
    try {
      const session = await createLiveSession();
      setTransfer({ session, text, files: [...files] });
    } catch (caught) {
      setError(
        caught instanceof ApiClientError
          ? caught.message
          : "실시간 연결을 만들지 못했어요.",
      );
      onBusyChange(false);
    } finally {
      setCreating(false);
    }
  };

  const reset = () => {
    controllerRef.current?.cancel();
    controllerRef.current = null;
    setTransfer(null);
    setFiles([]);
    setText("");
    setContentMode("files");
    setStatus("waiting");
    setCompleted(false);
    setProgress({ loadedBytes: 0, totalBytes: 0, currentFileName: null });
    setError(null);
    onBusyChange(false);
  };

  if (completed || status === "sent") {
    return <TerminalView kind="live-complete" onAction={reset} />;
  }

  if (transfer) {
    return (
      <LiveSessionResult
        session={transfer.session}
        status={status}
        progress={progress}
        error={error}
        onReset={reset}
      />
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="panel-intro">
        <p className="eyebrow">서버에 남기지 않기</p>
        <h1 id="live-send-heading">지금 바로 옮길까요?</h1>
        <p>두 화면을 동시에 열어 두면 파일과 텍스트가 바로 이동해요.</p>
      </div>

      <div className="live-explainer" role="note">
        <span className="live-mark" aria-hidden="true">
          <BoltIcon />
        </span>
        <div>
          <strong>10분 동안 연결을 기다려요</strong>
          <span>내용은 서버 파일이나 데이터베이스에 저장되지 않아요.</span>
        </div>
      </div>

      <div className="content-switch" aria-label="보낼 내용 종류">
        <button
          type="button"
          className={contentMode === "files" ? "active" : ""}
          aria-pressed={contentMode === "files"}
          onClick={() => setContentMode("files")}
          disabled={creating}
        >
          <FileIcon />
          파일
          {files.length > 0 && (
            <span className="count-badge">{files.length}</span>
          )}
        </button>
        <button
          type="button"
          className={contentMode === "text" ? "active" : ""}
          aria-pressed={contentMode === "text"}
          onClick={() => setContentMode("text")}
          disabled={creating}
        >
          <TextIcon />
          텍스트
          {text.trim().length > 0 && (
            <span className="status-dot" aria-label="입력됨" />
          )}
        </button>
      </div>

      {contentMode === "files" ? (
        <div className="content-area">
          <input
            ref={inputRef}
            id="live-file-input"
            className="sr-only"
            type="file"
            multiple
            onChange={onFileChange}
            disabled={creating}
          />
          <label
            className={`dropzone${dragActive ? " drag-active" : ""}`}
            htmlFor="live-file-input"
            aria-disabled={creating}
            onDragEnter={(event) => {
              event.preventDefault();
              if (!creating) setDragActive(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              ) {
                setDragActive(false);
              }
            }}
            onDrop={onDrop}
          >
            <span className="dropzone-icon" aria-hidden="true">
              <BoltIcon />
            </span>
            <strong>{dragActive ? "여기에 놓으세요" : "파일 선택"}</strong>
            <span>최대 {MAX_FILES}개, 합계 1GB까지 바로 보낼 수 있어요</span>
          </label>

          {files.length > 0 && (
            <div className="selected-files" aria-label="선택한 파일">
              <div className="selection-summary" role="status">
                <span>파일 {files.length}개</span>
                <span>{formatBytes(fileBytes)}</span>
              </div>
              <ul>
                {files.map((file, index) => (
                  <li
                    key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                  >
                    <span className="file-type-icon" aria-hidden="true">
                      <FileIcon />
                    </span>
                    <span className="file-details">
                      <span className="file-name">{file.name}</span>
                      <span className="file-size">
                        {formatBytes(file.size)}
                      </span>
                    </span>
                    <button
                      className="remove-button"
                      type="button"
                      aria-label={`${file.name} 삭제`}
                      onClick={() =>
                        setFiles(
                          files.filter((_, fileIndex) => fileIndex !== index),
                        )
                      }
                      disabled={creating}
                    >
                      <CloseIcon />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="text-button"
                onClick={() => inputRef.current?.click()}
                disabled={creating}
              >
                파일 더하기
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="content-area">
          <label className="text-label" htmlFor="live-share-text">
            실시간으로 보낼 텍스트
          </label>
          <textarea
            id="live-share-text"
            value={text}
            onChange={(event) => {
              const nextText = event.target.value;
              const nextTextBytes = new Blob([nextText]).size;
              if (nextTextBytes > MAX_TEXT_BYTES) {
                setError("텍스트는 최대 1MB까지 보낼 수 있어요.");
                return;
              }
              if (nextTextBytes + fileBytes > MAX_SHARE_BYTES) {
                setError("한 번에 옮길 수 있는 용량은 1GB예요.");
                return;
              }
              setText(nextText);
              setError(null);
            }}
            placeholder="상대 기기로 바로 보낼 텍스트를 붙여 넣으세요."
            rows={8}
            disabled={creating}
          />
          <div className="textarea-meta">
            <span>텍스트는 최대 1MB까지 보낼 수 있어요.</span>
            <span>{formatBytes(textBytes)}</span>
          </div>
        </div>
      )}

      {itemCount > 0 && (
        <p className="send-summary" aria-live="polite">
          바로 보낼 항목 {itemCount}개 · {formatBytes(totalBytes)}
        </p>
      )}

      {error && (
        <div className="inline-error" role="alert">
          <AlertIcon />
          <span>{error}</span>
        </div>
      )}

      <button className="primary-button" type="submit" disabled={creating}>
        {creating ? "연결 만드는 중…" : "실시간 코드 만들기"}
        {!creating && <ArrowRightIcon />}
      </button>
    </form>
  );
}

function LiveSessionResult({
  session,
  status,
  progress,
  error,
  onReset,
}: {
  session: CreateLiveSessionResponse;
  status: LiveSenderStatus;
  progress: LiveTransferProgress;
  error: string | null;
  onReset: () => void;
}) {
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(session.liveUrl, {
      width: 240,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#191f28", light: "#ffffff" },
    })
      .then((value) => {
        if (active) setQrCode(value);
      })
      .catch(() => {
        if (active) setQrError(true);
      });
    return () => {
      active = false;
    };
  }, [session.liveUrl]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  const copy = async (kind: "code" | "link", value: string) => {
    setCopyError(null);
    try {
      await copyText(value);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      setCopied(kind);
      copyTimerRef.current = window.setTimeout(() => setCopied(null), 1_600);
    } catch {
      setCopyError("자동으로 복사하지 못했어요. 직접 선택해 복사해 주세요.");
    }
  };

  return (
    <div className="share-result live-result" aria-live="polite">
      <div className={`live-status-card ${status}`}>
        <span className="live-status-symbol" aria-hidden="true">
          {status === "sent" ? <CheckIcon /> : <span className="live-pulse" />}
        </span>
        <div>
          <p className="eyebrow">실시간 전송</p>
          <h1 id="live-send-heading" ref={headingRef} tabIndex={-1}>
            {liveSenderStatusTitle(status)}
          </h1>
          <p>{liveSenderStatusDescription(status)}</p>
        </div>
      </div>

      {(status === "sending" || status === "confirming") && (
        <LiveProgress progress={progress} label="보내는 중" />
      )}

      <div className="result-grid">
        <div className="share-credentials">
          <div className="code-card">
            <span>실시간 코드</span>
            <strong aria-label={`실시간 코드 ${session.code}`}>
              {session.code}
            </strong>
            <button
              type="button"
              onClick={() => void copy("code", session.code)}
            >
              <CopyIcon />
              {copied === "code" ? "복사됨" : "코드 복사"}
            </button>
          </div>
          <div className="link-card">
            <span className="link-value">{session.liveUrl}</span>
            <button
              className="secondary-button compact"
              type="button"
              onClick={() => void copy("link", session.liveUrl)}
            >
              <LinkIcon />
              {copied === "link" ? "복사됨" : "링크 복사"}
            </button>
          </div>
          <span className="live-expiration">
            {formatDate(session.expiresAt)}까지 연결할 수 있어요.
          </span>
        </div>
        <div className="qr-card">
          {qrCode ? (
            <img
              src={qrCode}
              alt={`실시간 연결 ${session.liveUrl}의 QR 코드`}
            />
          ) : qrError ? (
            <span className="qr-error" role="status">
              QR을 만들지 못했어요.
              <br />
              링크를 사용해 주세요.
            </span>
          ) : (
            <span className="qr-placeholder" aria-label="QR 코드 만드는 중" />
          )}
          <span>상대 기기에서 스캔</span>
        </div>
      </div>

      {(error || copyError) && (
        <div className="inline-error" role="alert">
          <AlertIcon />
          <span>{error ?? copyError}</span>
        </div>
      )}

      <button className="secondary-button full" type="button" onClick={onReset}>
        {status === "sent" ? "다른 항목 보내기" : "전송 취소하고 닫기"}
      </button>
      <p className="privacy-note">
        전송이 끝날 때까지 두 화면을 열어 두세요. 연결 정보는 10분 뒤 사라져요.
      </p>
    </div>
  );
}

function LiveProgress({
  progress,
  label,
}: {
  progress: LiveTransferProgress;
  label: string;
}) {
  const percentage =
    progress.totalBytes === 0
      ? 0
      : Math.min(
          100,
          Math.round((progress.loadedBytes / progress.totalBytes) * 100),
        );
  return (
    <div className="upload-progress live-transfer-progress" aria-live="polite">
      <div className="progress-copy">
        <span>
          {progress.currentFileName
            ? `${label} · ${progress.currentFileName}`
            : label}
        </span>
        <strong>{percentage}%</strong>
      </div>
      <progress max="100" value={percentage} aria-label={`${label} 진행률`}>
        {percentage}%
      </progress>
      <span className="progress-bytes">
        {formatBytes(progress.loadedBytes)} / {formatBytes(progress.totalBytes)}
      </span>
    </div>
  );
}

function TerminalView({
  kind,
  onAction,
  standalone = false,
  actionLabel,
}: {
  kind: "stored-expired" | "live-complete";
  onAction: () => void;
  standalone?: boolean;
  actionLabel?: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const liveComplete = kind === "live-complete";

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section
      className={`${standalone ? "transfer-panel " : ""}error-view terminal-view${liveComplete ? " completed-view" : ""}`}
      aria-live="polite"
    >
      <span className="large-status-icon" aria-hidden="true">
        {liveComplete ? <CheckIcon /> : <InboxIcon />}
      </span>
      <p className="eyebrow">
        {liveComplete ? "실시간 전송 완료" : "보관 종료"}
      </p>
      <h1
        id={
          standalone
            ? undefined
            : liveComplete
              ? "live-send-heading"
              : "send-heading"
        }
        ref={headingRef}
        tabIndex={-1}
      >
        {liveComplete ? "전송을 완료했어요" : "보관 시간이 끝났어요"}
      </h1>
      <p>
        {liveComplete
          ? "수신 확인을 받았고 연결 코드도 닫았어요."
          : "공유 코드와 저장된 항목은 더 이상 열 수 없어요."}
      </p>
      <button className="primary-button" type="button" onClick={onAction}>
        {actionLabel ?? "다른 항목 보내기"}
      </button>
    </section>
  );
}

function useExpiration(expiresAt: string | null | undefined): boolean {
  const normalizedExpiresAt = expiresAt ?? null;
  const [expired, setExpired] = useState(() =>
    hasExpirationPassed(normalizedExpiresAt),
  );

  useEffect(() => {
    if (normalizedExpiresAt === null || expired) return;
    let timer: number | null = null;

    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const schedule = () => {
      clearTimer();
      const delay = getNextExpirationDelay(normalizedExpiresAt);
      timer = window.setTimeout(() => {
        if (hasExpirationPassed(normalizedExpiresAt)) {
          setExpired(true);
        } else {
          schedule();
        }
      }, delay);
    };
    const recheck = () => {
      if (hasExpirationPassed(normalizedExpiresAt)) {
        clearTimer();
        setExpired(true);
      } else {
        schedule();
      }
    };

    schedule();
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      clearTimer();
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [expired, normalizedExpiresAt]);

  return expired;
}

function ReceiveForm({
  active,
  onReceive,
}: {
  active: boolean;
  onReceive: (result: ResolveCodeResponse) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError("6자리 숫자를 입력해 주세요.");
      return;
    }
    setResolving(true);
    setError(null);
    try {
      onReceive(await resolveReceiveCode(code));
    } catch (requestError) {
      setError(
        requestError instanceof ApiClientError
          ? requestError.message
          : "코드를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.",
      );
      setResolving(false);
    }
  };

  return (
    <form
      className="receive-form"
      onSubmit={submit}
      noValidate
      aria-busy={resolving}
    >
      <div className="panel-intro">
        <p className="eyebrow">코드로 자동 연결</p>
        <h1 id="receive-heading">받을 준비 됐어요</h1>
        <p>
          6자리 코드만 입력하면 보관 공유인지 실시간 연결인지 자동으로 찾아요.
        </p>
      </div>
      <label className="code-label" htmlFor="receive-code">
        받기 코드
      </label>
      <input
        ref={inputRef}
        id="receive-code"
        className="code-input"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        placeholder="000000"
        value={code}
        disabled={resolving}
        aria-invalid={error !== null}
        aria-describedby={error ? "code-help receive-error" : "code-help"}
        onChange={(event) => {
          setCode(event.target.value.replace(/\D/g, "").slice(0, 6));
          setError(null);
        }}
      />
      <p id="code-help" className="field-help">
        보관 공유와 실시간 연결을 자동으로 구분해요.
      </p>
      {error && (
        <div id="receive-error" className="inline-error" role="alert">
          <AlertIcon />
          <span>{error}</span>
        </div>
      )}
      <button className="primary-button" type="submit" disabled={resolving}>
        {resolving ? "코드 확인 중…" : "항목 받기"}
        <ArrowRightIcon />
      </button>
    </form>
  );
}

function ShareResult({
  share,
  onReset,
}: {
  share: ShareResponse;
  onReset: () => void;
}) {
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const expired = useExpiration(share.expiresAt);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(share.shareUrl, {
      width: 240,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#191f28", light: "#ffffff" },
    })
      .then((value) => {
        if (active) setQrCode(value);
      })
      .catch(() => {
        if (active) setQrError(true);
      });
    return () => {
      active = false;
    };
  }, [share.shareUrl]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!expired) return;
    void getShare(share.code).catch(() => undefined);
  }, [expired, share.code]);

  const copy = async (kind: "code" | "link", value: string) => {
    setCopyError(null);
    try {
      await copyText(value);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      setCopied(kind);
      copyTimerRef.current = window.setTimeout(() => setCopied(null), 1_600);
    } catch {
      setCopyError("자동으로 복사하지 못했어요. 직접 선택해 복사해 주세요.");
    }
  };

  if (expired) {
    return <TerminalView kind="stored-expired" onAction={onReset} />;
  }

  return (
    <div className="share-result" aria-live="polite">
      <div className="completion-motion" aria-hidden="true">
        <span className="packet packet-back" />
        <span className="packet packet-middle" />
        <span className="packet packet-front">
          <ArrowUpRightIcon />
        </span>
        <span className="arrival-dot" />
      </div>
      <div className="result-intro">
        <span className="success-check" aria-hidden="true">
          <CheckIcon />
        </span>
        <div>
          <p className="eyebrow">전송 준비 완료</p>
          <h1 id="send-heading" ref={headingRef} tabIndex={-1}>
            옮길 준비가 됐어요
          </h1>
          <p>
            {share.expiresAt
              ? `${formatDate(share.expiresAt)}까지`
              : "만료 없이"}{" "}
            열 수 있어요.
          </p>
        </div>
      </div>

      <div className="result-grid">
        <div className="share-credentials">
          <div className="code-card">
            <span>공유 코드</span>
            <strong aria-label={`공유 코드 ${share.code}`}>{share.code}</strong>
            <button type="button" onClick={() => void copy("code", share.code)}>
              <CopyIcon />
              {copied === "code" ? "복사됨" : "코드 복사"}
            </button>
          </div>
          <div className="link-card">
            <span className="link-value">{share.shareUrl}</span>
            <button
              className="secondary-button compact"
              type="button"
              onClick={() => void copy("link", share.shareUrl)}
            >
              <LinkIcon />
              {copied === "link" ? "복사됨" : "링크 복사"}
            </button>
          </div>
          <a className="open-link" href={share.shareUrl}>
            받는 화면 미리보기
            <ArrowUpRightIcon />
          </a>
        </div>
        <div className="qr-card">
          {qrCode ? (
            <img src={qrCode} alt={`공유 링크 ${share.shareUrl}의 QR 코드`} />
          ) : qrError ? (
            <span className="qr-error" role="status">
              QR을 만들지 못했어요.
              <br />
              링크를 사용해 주세요.
            </span>
          ) : (
            <span className="qr-placeholder" aria-label="QR 코드 만드는 중" />
          )}
          <span>카메라로 스캔</span>
        </div>
      </div>

      {copyError && (
        <div className="inline-error" role="alert">
          <AlertIcon />
          <span>{copyError}</span>
        </div>
      )}

      <button className="secondary-button full" type="button" onClick={onReset}>
        다른 항목 보내기
      </button>
      <p className="privacy-note">
        코드나 링크를 아는 사람은 내용을 열 수 있어요. 필요한 사람에게만 알려
        주세요.
      </p>
    </div>
  );
}

function LiveReceiveView({
  code,
  onReceiveAnother,
}: {
  code: string;
  onReceiveAnother: () => void;
}) {
  const [joining, setJoining] = useState(true);
  const [status, setStatus] = useState<LiveReceiverStatus>("connecting");
  const [received, setReceived] = useState<{
    payload: LiveReceivedPayload;
    downloadUrls: string[];
  } | null>(null);
  const [progress, setProgress] = useState<LiveTransferProgress>({
    loadedBytes: 0,
    totalBytes: 0,
    currentFileName: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const controllerRef = useRef<LivePeerController | null>(null);
  const joinPromiseRef = useRef<ReturnType<typeof joinLiveSession> | null>(
    null,
  );
  const receiveEffectActiveRef = useRef(false);

  useEffect(() => {
    let active = true;
    let controller: LivePeerController | null = null;
    const createdUrls: string[] = [];
    receiveEffectActiveRef.current = true;

    // React Strict Mode replays newly mounted effects in development. Reuse the
    // first join request so the replay does not claim a second receiver slot.
    const joinPromise =
      joinPromiseRef.current ??
      (joinPromiseRef.current = joinLiveSession(code));

    void joinPromise
      .then((session) => {
        if (!active) return;
        setJoining(false);
        controller = startLiveReceiver(session, {
          onStatus: setStatus,
          onProgress: setProgress,
          onPayload: (payload) => {
            const downloadUrls = payload.files.map((file) => {
              const url = URL.createObjectURL(file.blob);
              createdUrls.push(url);
              return url;
            });
            setReceived({ payload, downloadUrls });
          },
          onError: (message) => setError(message),
        });
        controllerRef.current = controller;
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setJoining(false);
        setError(
          caught instanceof ApiClientError
            ? caught.message
            : "실시간 연결에 들어가지 못했어요.",
        );
      });

    return () => {
      active = false;
      receiveEffectActiveRef.current = false;
      controller?.stop();
      if (controllerRef.current === controller) controllerRef.current = null;
      createdUrls.forEach((url) => URL.revokeObjectURL(url));

      queueMicrotask(() => {
        if (receiveEffectActiveRef.current || controller !== null) return;
        void joinPromise
          .then((session) => closeLiveSession(code, session.receiverToken))
          .catch(() => undefined);
      });
    };
  }, [code]);

  useEffect(() => {
    if (!joining) headingRef.current?.focus();
  }, [joining]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  const copyReceivedText = async () => {
    const text = received?.payload.text;
    if (text === null || text === undefined) return;
    setCopyError(null);
    try {
      await copyText(text);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      setCopied(true);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopyError("자동으로 복사하지 못했어요. 직접 선택해 복사해 주세요.");
    }
  };

  const cancelAndLeave = () => {
    controllerRef.current?.cancel();
    onReceiveAnother();
  };

  if (error) {
    return (
      <section className="transfer-panel error-view" aria-live="polite">
        <span className="large-status-icon" aria-hidden="true">
          <BoltIcon />
        </span>
        <p className="eyebrow">실시간 연결 종료</p>
        <h1 ref={headingRef} tabIndex={-1}>
          연결하지 못했어요
        </h1>
        <p>{error}</p>
        <button
          className="primary-button"
          type="button"
          onClick={onReceiveAnother}
        >
          다른 실시간 코드 입력하기
        </button>
      </section>
    );
  }

  if (received) {
    return (
      <section className="transfer-panel received-share live-received">
        <div className="received-heading">
          <span className="received-icon" aria-hidden="true">
            <BoltIcon />
          </span>
          <div>
            <p className="eyebrow">실시간 수령 완료</p>
            <h1 ref={headingRef} tabIndex={-1}>
              바로 도착했어요
            </h1>
            <p>서버 저장 없이 연결된 기기에서 받은 항목이에요.</p>
          </div>
        </div>

        {received.payload.text !== null && (
          <div className="received-section">
            <div className="section-heading">
              <h2>텍스트</h2>
              <button
                className="text-button"
                type="button"
                onClick={() => void copyReceivedText()}
              >
                <CopyIcon />
                {copied ? "복사됨" : "복사"}
              </button>
            </div>
            <pre className="shared-text">{received.payload.text}</pre>
            {copyError && (
              <div className="inline-error" role="alert">
                <AlertIcon />
                <span>{copyError}</span>
              </div>
            )}
          </div>
        )}

        {received.payload.files.length > 0 && (
          <div className="received-section">
            <div className="section-heading">
              <h2>파일 {received.payload.files.length}개</h2>
              <span>{formatBytes(received.payload.totalBytes)}</span>
            </div>
            <ul className="download-list">
              {received.payload.files.map((file, index) => (
                <li key={file.id}>
                  <span className="file-type-icon" aria-hidden="true">
                    <FileIcon />
                  </span>
                  <span className="file-details">
                    <span className="file-name">{file.name}</span>
                    <span className="file-size">{formatBytes(file.size)}</span>
                  </span>
                  <a
                    className="download-button"
                    href={received.downloadUrls[index]}
                    download={file.name}
                  >
                    <DownloadIcon />
                    다운로드
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          className="secondary-button full"
          type="button"
          onClick={onReceiveAnother}
        >
          다른 실시간 항목 받기
        </button>
        <p className="privacy-note">
          받은 항목은 현재 브라우저 메모리에만 있어요. 화면을 닫기 전에 파일을
          내려받거나 텍스트를 복사하세요.
        </p>
      </section>
    );
  }

  return (
    <section
      className="transfer-panel receive-view live-connecting"
      role="status"
      aria-live="polite"
    >
      <div className="live-connection-motion" aria-hidden="true">
        <span />
        <BoltIcon />
        <span />
      </div>
      <p className="eyebrow">실시간 코드 {code}</p>
      <h1 ref={headingRef} tabIndex={-1}>
        {joining ? "연결을 확인하고 있어요" : liveReceiverStatusTitle(status)}
      </h1>
      <p className="muted">
        보내는 화면을 닫지 마세요. 연결되면 항목이 바로 도착해요.
      </p>
      {!joining && progress.totalBytes > 0 && (
        <LiveProgress progress={progress} label="받는 중" />
      )}
      <button
        className="secondary-button"
        type="button"
        onClick={cancelAndLeave}
      >
        수신 취소
      </button>
    </section>
  );
}

function ShareView({
  code,
  onReceiveAnother,
}: {
  code: string;
  onReceiveAnother: () => void;
}) {
  const [share, setShare] = useState<ShareResponse | null>(null);
  const [error, setError] = useState<{
    code: string;
    message: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const expired = useExpiration(share?.expiresAt);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void getShare(code, controller.signal)
      .then((response) => {
        if (active) setShare(response);
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(
            caught instanceof ApiClientError
              ? { code: caught.code, message: caught.message }
              : {
                  code: "REQUEST_FAILED",
                  message: "공유를 불러오지 못했어요.",
                },
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [code]);

  useEffect(() => {
    if (!loading) headingRef.current?.focus();
  }, [loading]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!expired) return;
    void getShare(code).catch(() => undefined);
  }, [code, expired]);

  const copySharedText = async () => {
    if (!share?.text) return;
    setCopyError(null);
    try {
      await copyText(share.text);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      setCopied(true);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopyError("자동으로 복사하지 못했어요. 직접 선택해 복사해 주세요.");
    }
  };

  if (loading) {
    return (
      <section
        className="transfer-panel receive-view"
        role="status"
        aria-live="polite"
      >
        <div className="loading-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h1>항목을 찾고 있어요</h1>
        <p className="muted">코드 {code}</p>
      </section>
    );
  }

  if (expired || error?.code === "SHARE_NOT_FOUND") {
    return (
      <TerminalView
        kind="stored-expired"
        standalone
        actionLabel="다른 코드 입력하기"
        onAction={onReceiveAnother}
      />
    );
  }

  if (error || !share) {
    return (
      <section className="transfer-panel error-view" aria-live="polite">
        <span className="large-status-icon" aria-hidden="true">
          <SearchIcon />
        </span>
        <p className="eyebrow">코드 {code}</p>
        <h1 ref={headingRef} tabIndex={-1}>
          항목을 열지 못했어요
        </h1>
        <p>{error?.message ?? "코드를 다시 확인해 주세요."}</p>
        <button
          className="primary-button"
          type="button"
          onClick={onReceiveAnother}
        >
          다른 코드 입력하기
        </button>
      </section>
    );
  }

  const itemCount = share.files.length + (share.text ? 1 : 0);
  return (
    <section className="transfer-panel received-share">
      <div className="received-heading">
        <span className="received-icon" aria-hidden="true">
          <InboxIcon />
        </span>
        <div>
          <p className="eyebrow">코드 {share.code}</p>
          <h1 ref={headingRef} tabIndex={-1}>
            도착한 항목이에요
          </h1>
          <p>
            {itemCount}개 · {formatBytes(share.totalBytes)}
            <span aria-hidden="true"> · </span>
            {share.expiresAt
              ? `${formatDate(share.expiresAt)}까지`
              : "만료 없음"}
          </p>
        </div>
      </div>

      {share.text && (
        <div className="received-section">
          <div className="section-heading">
            <h2>텍스트</h2>
            <button
              className="text-button"
              type="button"
              onClick={() => void copySharedText()}
            >
              <CopyIcon />
              {copied ? "복사됨" : "복사"}
            </button>
          </div>
          <pre className="shared-text">{share.text}</pre>
          {copyError && (
            <div className="inline-error" role="alert">
              <AlertIcon />
              <span>{copyError}</span>
            </div>
          )}
        </div>
      )}

      {share.files.length > 0 && (
        <div className="received-section">
          <div className="section-heading">
            <h2>파일 {share.files.length}개</h2>
          </div>
          <ul className="download-list">
            {share.files.map((file) => (
              <li key={file.id}>
                <span className="file-type-icon" aria-hidden="true">
                  <FileIcon />
                </span>
                <span className="file-details">
                  <span className="file-name">{file.name}</span>
                  <span className="file-size">{formatBytes(file.size)}</span>
                </span>
                <a
                  href={file.downloadUrl}
                  download={file.name}
                  aria-label={`${file.name} 다운로드`}
                >
                  <DownloadIcon />
                  <span className="download-label">받기</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        className="secondary-button full"
        type="button"
        onClick={onReceiveAnother}
      >
        다른 항목 받기
      </button>
      <p className="privacy-note">
        다운로드한 뒤에는 이 페이지를 닫아도 괜찮아요.
      </p>
    </section>
  );
}

function parseRoute(pathname: string): AppRoute {
  const storedCode = pathname.match(/^\/s\/(\d{6})\/?$/)?.[1];
  if (storedCode) {
    return { kind: "stored", code: storedCode };
  }
  const liveCode = pathname.match(/^\/live\/(\d{6})\/?$/)?.[1];
  if (liveCode) {
    return { kind: "live", code: liveCode };
  }
  return null;
}

function liveSenderStatusTitle(status: LiveSenderStatus): string {
  switch (status) {
    case "waiting":
      return "상대를 기다리고 있어요";
    case "connecting":
      return "기기끼리 연결하고 있어요";
    case "sending":
      return "항목을 바로 보내고 있어요";
    case "confirming":
      return "도착 확인을 기다리고 있어요";
    case "sent":
      return "상대 기기에 도착했어요";
  }
}

function liveSenderStatusDescription(status: LiveSenderStatus): string {
  switch (status) {
    case "waiting":
      return "아래 코드나 링크를 상대 기기에서 열어 주세요.";
    case "connecting":
      return "연결 정보만 서버를 거치고 내용은 기기끼리 이동해요.";
    case "sending":
      return "큰 파일도 작은 조각으로 나눠 안전하게 보내요.";
    case "confirming":
      return "모든 항목을 보냈고 상대 기기의 수신 확인을 기다려요.";
    case "sent":
      return "수신 확인을 받았어요. 이제 이 화면을 닫아도 돼요.";
  }
}

function liveReceiverStatusTitle(status: LiveReceiverStatus): string {
  switch (status) {
    case "connecting":
      return "보내는 기기와 연결 중이에요";
    case "receiving":
      return "항목을 받고 있어요";
    case "received":
      return "모든 항목이 도착했어요";
  }
}

function getInitialTheme(): Theme {
  const stored = window.localStorage.getItem("move-it-theme");
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Some browsers expose Clipboard API but block it by permission policy.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.className = "sr-only";
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  const previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  previousFocus?.focus();
  if (!copied) {
    throw new Error("Clipboard copy was rejected.");
  }
}

function SvgIcon({
  children,
  viewBox = "0 0 24 24",
}: {
  children: ReactNode;
  viewBox?: string;
}) {
  return (
    <svg viewBox={viewBox} fill="none" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

function ArrowUpRightIcon() {
  return (
    <SvgIcon>
      <path d="M7 17 17 7M8 7h9v9" />
    </SvgIcon>
  );
}

function ArrowRightIcon() {
  return (
    <SvgIcon>
      <path d="M5 12h14M14 7l5 5-5 5" />
    </SvgIcon>
  );
}

function MoonIcon() {
  return (
    <SvgIcon>
      <path d="M20 15.3A8.5 8.5 0 0 1 8.7 4a8.5 8.5 0 1 0 11.3 11.3Z" />
    </SvgIcon>
  );
}

function SunIcon() {
  return (
    <SvgIcon>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
    </SvgIcon>
  );
}

function FileIcon() {
  return (
    <SvgIcon>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h4" />
    </SvgIcon>
  );
}

function TextIcon() {
  return (
    <SvgIcon>
      <path d="M5 6h14M5 10h14M5 14h9M5 18h11" />
    </SvgIcon>
  );
}

function PlusIcon() {
  return (
    <SvgIcon>
      <path d="M12 5v14M5 12h14" />
    </SvgIcon>
  );
}

function CloseIcon() {
  return (
    <SvgIcon>
      <path d="m7 7 10 10M17 7 7 17" />
    </SvgIcon>
  );
}

function ChevronDownIcon() {
  return (
    <SvgIcon>
      <path d="m7 10 5 5 5-5" />
    </SvgIcon>
  );
}

function AlertIcon() {
  return (
    <SvgIcon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6M12 17h.01" />
    </SvgIcon>
  );
}

function CheckIcon() {
  return (
    <SvgIcon>
      <path d="m6 12 4 4 8-9" />
    </SvgIcon>
  );
}

function CopyIcon() {
  return (
    <SvgIcon>
      <rect x="8" y="8" width="10" height="10" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </SvgIcon>
  );
}

function LinkIcon() {
  return (
    <SvgIcon>
      <path
        d="m10 13 4-4M7.5 15.5l-1 1a3.54 3.54 0 0 1-5-5l3-3a3.54 3.54 0 0 1 5 0M16.5 8.5l1-1a3.54 3.54 0 0 1 5 5l-3 3a3.54 3.54 0 0 1-5 0"
        transform="translate(.5 -.5)"
      />
    </SvgIcon>
  );
}

function SearchIcon() {
  return (
    <SvgIcon>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </SvgIcon>
  );
}

function InboxIcon() {
  return (
    <SvgIcon>
      <path d="M4 5h16v14H4z" />
      <path d="M4 13h4l2 3h4l2-3h4" />
    </SvgIcon>
  );
}

function DownloadIcon() {
  return (
    <SvgIcon>
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </SvgIcon>
  );
}

function BoltIcon() {
  return (
    <SvgIcon>
      <path d="m13 2-8 12h7l-1 8 8-12h-7z" />
    </SvgIcon>
  );
}
