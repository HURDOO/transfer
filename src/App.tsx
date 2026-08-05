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
  type ExpirationValue,
  type ShareResponse,
} from "../shared/contracts";
import { ApiClientError, createShare, getShare } from "./api";
import { formatBytes, formatDate } from "./format";

type Theme = "light" | "dark";
type HomeMode = "send" | "receive";
type ContentMode = "files" | "text";

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
  const [route, setRoute] = useState(() =>
    parseShareCode(window.location.pathname),
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
    const onPopState = () => setRoute(parseShareCode(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (path: string) => {
    window.history.pushState({}, "", path);
    setRoute(parseShareCode(path));
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  const navigateHome = (mode: HomeMode = "send") => {
    setHomeMode(mode);
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
        {route ? (
          <ShareView
            key={route}
            code={route}
            onReceiveAnother={() => navigateHome("receive")}
          />
        ) : (
          <Home
            initialMode={homeMode}
            onReceive={(code) => navigate(`/s/${code}`)}
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
  onReceive,
}: {
  initialMode: HomeMode;
  onReceive: (code: string) => void;
}) {
  const [mode, setMode] = useState<HomeMode>(initialMode);
  const [sendBusy, setSendBusy] = useState(false);

  return (
    <section
      className="transfer-panel"
      aria-labelledby={mode === "send" ? "send-heading" : "receive-heading"}
    >
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
      <div hidden={mode !== "send"}>
        <SendFlow onBusyChange={setSendBusy} />
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
    return <ShareResult share={result} onReset={reset} />;
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

function ReceiveForm({
  active,
  onReceive,
}: {
  active: boolean;
  onReceive: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError("6자리 숫자를 입력해 주세요.");
      return;
    }
    onReceive(code);
  };

  return (
    <form className="receive-form" onSubmit={submit} noValidate>
      <div className="panel-intro">
        <p className="eyebrow">코드로 바로 찾기</p>
        <h1 id="receive-heading">받을 준비 됐어요</h1>
        <p>보내는 화면에 나온 6자리 숫자를 입력하세요.</p>
      </div>
      <label className="code-label" htmlFor="receive-code">
        공유 코드
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
        aria-invalid={error !== null}
        aria-describedby={error ? "code-help receive-error" : "code-help"}
        onChange={(event) => {
          setCode(event.target.value.replace(/\D/g, "").slice(0, 6));
          setError(null);
        }}
      />
      <p id="code-help" className="field-help">
        띄어쓰기 없이 숫자만 입력해 주세요.
      </p>
      {error && (
        <div id="receive-error" className="inline-error" role="alert">
          <AlertIcon />
          <span>{error}</span>
        </div>
      )}
      <button className="primary-button" type="submit">
        항목 열기
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

function ShareView({
  code,
  onReceiveAnother,
}: {
  code: string;
  onReceiveAnother: () => void;
}) {
  const [share, setShare] = useState<ShareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const copyTimerRef = useRef<number | null>(null);

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
              ? caught.message
              : "공유를 불러오지 못했어요.",
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
        <p>{error ?? "코드를 다시 확인해 주세요."}</p>
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

function parseShareCode(pathname: string): string | null {
  return pathname.match(/^\/s\/(\d{6})\/?$/)?.[1] ?? null;
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
