import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Bot, Loader2, RefreshCw, Send, Trash2 } from "lucide-react";
import { fetchWithAuth } from "../../../lib/api";
import { markAgentValidated } from "../../../lib/activation";
import {
  checkedRecovery,
  checkpointKey,
  knownRefusal,
  loadPending,
  pendingLabel,
  savePending,
  scopeKey,
  type PendingChat,
} from "../../../lib/chatRecovery";

function formatMessageTime(value) {
  try {
    if (!value || Number.isNaN(new Date(value).getTime())) return "";
    return new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function HermesChatPanel(props) {
  const scope = props.runtimeInfo?.chatScope;
  return (
    <HermesChatSession
      key={JSON.stringify([props.agentId, scope?.ownerId, scope?.profile])}
      {...props}
    />
  );
}

function HermesChatSession({
  agentId,
  runtimeInfo,
  loadingRuntime,
  runtimeError,
  onRefreshRuntime,
}) {
  const [sending, setSending] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [pending, setPending] = useState<PendingChat | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [checkpointReady, setCheckpointReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const messageListRef = useRef(null);
  const scope =
    runtimeInfo?.chatScope?.agentId === agentId && runtimeInfo.chatScope.profile === null
      ? runtimeInfo.chatScope
      : null;
  const key = scope ? scopeKey(scope) : "";
  const current = useRef({ key, generation: 0 });
  if (current.current.key !== key)
    current.current = { key, generation: current.current.generation + 1 };
  const abort = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const runtimeReady = Boolean(runtimeInfo?.health?.ok);
  const defaultModel =
    runtimeInfo?.configuredModel ||
    runtimeInfo?.defaultModel ||
    runtimeInfo?.models?.[0]?.id ||
    null;
  const blocked = Boolean(
    pending || sending || recovering || storageError || !checkpointReady || !scope,
  );

  useEffect(() => {
    abort.current?.abort();
    busy.current = false;
    setMessages([]);
    setDraft("");
    setSessionId("");
    setError("");
    setSending(false);
    setRecovering(false);
    setPending(null);
    setStorageError("");
    setCheckpointReady(false);
    if (scope) {
      try {
        const saved = loadPending(sessionStorage, scope);
        setPending(saved);
        if (saved) setSessionId(saved.sessionId);
        setCheckpointReady(true);
      } catch (e) {
        setStorageError(e.message);
      }
    }
    return () => {
      current.current.generation++;
      abort.current?.abort();
    };
  }, [key]);
  useEffect(() => {
    if (messageListRef.current)
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [messages, sending]);

  function capture() {
    const stamp = { ...current.current };
    const controller = new AbortController();
    abort.current = controller;
    return {
      signal: controller.signal,
      valid: () =>
        stamp.key === current.current.key &&
        stamp.generation === current.current.generation &&
        !controller.signal.aborted,
    };
  }
  async function stillOwner(operation, ownerId) {
    if (!operation.valid()) return false;
    const response = await fetchWithAuth("/api/auth/me", { signal: operation.signal });
    const user = await response.json();
    if (!operation.valid()) return false;
    if (!response.ok || user.id !== ownerId) {
      current.current.generation++;
      busy.current = false;
      setMessages([]);
      setDraft("");
      setPending(null);
      setSending(false);
      setRecovering(false);
      setCheckpointReady(false);
      setError("Your account changed. Refresh the runtime before continuing.");
      onRefreshRuntime();
      return false;
    }
    return true;
  }
  function forget(p) {
    try {
      sessionStorage.removeItem(checkpointKey(p));
      setPending(null);
    } catch {
      setStorageError(
        "The saved request could not be updated. Keep this tab open and contact support.",
      );
    }
  }
  function resetConversation() {
    if (blocked || busy.current) return;
    setMessages([]);
    setSessionId("");
    setError("");
  }
  async function refreshRequest(resolve = false) {
    if (!pending || busy.current || !scope) return;
    if (
      resolve &&
      !window.confirm(
        "This request may already have run. Discard its remaining work? This does not undo actions it already took.",
      )
    )
      return;
    const p = pending,
      operation = capture();
    busy.current = true;
    setRecovering(true);
    setError("");
    try {
      const query = new URLSearchParams({
        ownerId: p.ownerId,
        requestId: p.requestId,
        sessionId: p.sessionId,
      });
      const response = await fetchWithAuth(
        `/api/agents/${p.agentId}/hermes-ui/chat${resolve ? "/resolve" : `?${query}`}`,
        {
          signal: operation.signal,
          ...(resolve ? { method: "POST", body: JSON.stringify({ ...p, confirm: true }) } : {}),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!operation.valid() || !(await stillOwner(operation, p.ownerId))) return;
      if (!response.ok)
        throw new Error(
          data.error || "The request could not be verified. Refresh again; do not resend it.",
        );
      const result = checkedRecovery(data, p.receipt);
      if (result.receipt.status === "terminal") {
        if (result.historyAvailable && Array.isArray(result.history)) {
          setMessages(result.history.map((m, i) => ({ ...m, id: `history-${i}` })));
        } else if (result.output) {
          setMessages((rows) => [
            ...rows,
            {
              id: `recovered-${p.requestId}`,
              role: "assistant",
              content: result.output,
              createdAt: new Date().toISOString(),
            },
          ]);
        }
        forget(p);
        setError(
          result.historyAvailable
            ? ""
            : "The request is settled. Conversation history is temporarily unavailable.",
        );
      } else {
        const next = { ...p, status: result.status, runId: result.runId, receipt: result.receipt };
        savePending(sessionStorage, next);
        setPending(next);
        if (result.historyAvailable)
          setMessages(result.history.map((m, i) => ({ ...m, id: `history-${i}` })));
      }
    } catch (e) {
      if (operation.valid())
        setError(e.message || "The request remains unconfirmed. Refresh again before continuing.");
    } finally {
      if (operation.valid()) {
        busy.current = false;
        setRecovering(false);
      }
    }
  }
  async function handleSend() {
    const content = draft.trim();
    if (!content || blocked || busy.current || !runtimeReady || !scope) return;
    const p: PendingChat = {
      ...scope,
      version: 1,
      requestId: crypto.randomUUID(),
      sessionId: sessionId || crypto.randomUUID(),
      status: "unconfirmed",
    };
    try {
      savePending(sessionStorage, p);
    } catch {
      setStorageError(
        "This browser could not save the request identity. Enable session storage before sending.",
      );
      return;
    }
    const nextUserMessage = {
      id: `user-${p.requestId}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    const nextMessages = [...messages, nextUserMessage],
      operation = capture();
    busy.current = true;
    setMessages(nextMessages);
    setDraft("");
    setPending(p);
    setSessionId(p.sessionId);
    setSending(true);
    setError("");
    // A refusal from POST itself proves no input was admitted. A failed owner
    // refresh after a successful POST cannot make that same claim.
    let refused = false,
      ownerVerified = false;
    try {
      let response;
      try {
        response = await fetchWithAuth(`/api/agents/${p.agentId}/hermes-ui/chat`, {
          method: "POST",
          signal: operation.signal,
          body: JSON.stringify({
            ...p,
            ...(defaultModel ? { model: defaultModel } : {}),
            messages: nextMessages.map(({ role, content }) => ({ role, content })),
          }),
        });
      } catch (e) {
        refused = e.message === "Unauthorized";
        throw e;
      }
      const data = await response.json().catch(() => ({}));
      refused = !response.ok && knownRefusal(response.status, data);
      if (!operation.valid()) return;
      if (!(await stillOwner(operation, p.ownerId))) return;
      ownerVerified = true;
      if (!response.ok && refused)
        throw new Error(data.error || "The request was refused before it could run.");
      if (!response.ok) {
        const status =
          data.code === "admission_queued"
            ? "queued"
            : data.code === "unknown_execution"
              ? "unknown"
              : "unconfirmed";
        const next = { ...p, status };
        savePending(sessionStorage, next);
        setPending(next);
        throw new Error(
          "The request may have been accepted. Refresh its status before continuing.",
        );
      }
      if (typeof data.message !== "string" || !data.message)
        throw new Error("The reply could not be verified. Refresh this request's status.");
      setSessionId(data.sessionId || p.sessionId);
      forget(p);
      markAgentValidated(p.agentId, "hermes_chat");
      setMessages([
        ...nextMessages,
        {
          id: `assistant-${p.requestId}`,
          role: "assistant",
          content: data.message,
          usage: data.usage || null,
          model: data.model || defaultModel,
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (e) {
      if (!operation.valid()) return;
      if (refused) {
        forget(p);
        if (ownerVerified) {
          setMessages(messages);
          setDraft(content);
        } else {
          setMessages([]);
          setDraft("");
          setCheckpointReady(false);
          onRefreshRuntime();
        }
      }
      setError(
        e.message || "The request may have been accepted. Refresh its status before continuing.",
      );
    } finally {
      if (operation.valid()) {
        busy.current = false;
        setSending(false);
      }
    }
  }

  function handleComposerKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    handleSend();
  }

  if (loadingRuntime && !runtimeInfo) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-700">
            Headmaster Chat
          </p>
          <p className="mt-1 text-sm font-bold text-slate-900">
            Direct conversation with the running Headmaster workspace.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {defaultModel ? `Default model: ${defaultModel}` : "No model reported yet"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ${
              runtimeReady ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                runtimeReady ? "bg-emerald-500" : "animate-pulse bg-amber-500"
              }`}
            />
            {runtimeReady ? "Ready" : "Waiting"}
          </span>
          <button
            onClick={onRefreshRuntime}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50"
          >
            <RefreshCw size={12} className={loadingRuntime ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {runtimeError ? (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
          <div>
            <p className="text-sm font-bold text-amber-800">Runtime check warning</p>
            <p className="mt-1 text-xs text-amber-700">{runtimeError}</p>
          </div>
        </div>
      ) : null}

      {pending || storageError ? (
        <div
          role="status"
          className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3"
        >
          <p className="text-sm font-bold text-amber-800">
            {storageError ? "Chat is paused" : pendingLabel(pending.status)}
          </p>
          <p className="text-xs text-amber-700">
            {storageError ||
              "Your sent request is kept here. Check its status before sending another message or resetting this conversation."}
          </p>
          {pending ? (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => refreshRequest()}
                disabled={sending || recovering}
                className="inline-flex items-center gap-1.5 rounded-xl border border-amber-300 px-3 py-2 text-xs font-bold text-amber-800 disabled:opacity-50"
              >
                <RefreshCw size={12} />
                {recovering ? "Checking request" : "Refresh request"}
              </button>
              {pending.receipt?.status === "unknown" && pending.receipt.execution_generation ? (
                <button
                  onClick={() => refreshRequest(true)}
                  disabled={sending || recovering}
                  className="rounded-xl border border-amber-300 px-3 py-2 text-xs font-bold text-amber-800 disabled:opacity-50"
                >
                  Discard remaining work
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-600" />
          <div>
            <p className="text-sm font-bold text-rose-800">Chat request failed</p>
            <p className="mt-1 text-xs text-rose-700">{error}</p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]" style={{ minHeight: "560px" }}>
        <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div>
              <p className="text-sm font-bold text-slate-900">Conversation</p>
              <p className="mt-1 text-xs text-slate-500">
                {runtimeReady
                  ? "Session-aware chat against the running Headmaster API."
                  : runtimeInfo?.health?.error || "Waiting for Headmaster to finish starting."}
              </p>
            </div>
            <button
              onClick={resetConversation}
              disabled={blocked || (!messages.length && !sessionId)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 size={12} />
              Reset
            </button>
          </div>

          <div
            ref={messageListRef}
            className="flex-1 space-y-4 overflow-y-auto bg-slate-50/70 px-4 py-4"
          >
            {messages.length === 0 ? (
              <div className="flex h-full min-h-[280px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white px-6 text-center">
                <Bot size={26} className="text-slate-300" />
                <p className="mt-3 text-sm font-bold text-slate-700">
                  {pending ? "Sent request awaiting status" : "No active conversation yet"}
                </p>
                <p className="mt-1 max-w-sm text-xs text-slate-500">
                  {pending
                    ? "Refresh request to load its saved conversation."
                    : "Send a prompt once the Headmaster runtime reports healthy status."}
                </p>
              </div>
            ) : (
              messages.map((message) => {
                const isAssistant = message.role === "assistant";
                return (
                  <div
                    key={message.id}
                    className={`flex ${isAssistant ? "justify-start" : "justify-end"}`}
                  >
                    <div
                      className={`max-w-[88%] rounded-2xl px-4 py-3 shadow-sm ${
                        isAssistant
                          ? "border border-slate-200 bg-white text-slate-800"
                          : "bg-blue-600 text-white"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span
                          className={`text-[10px] font-black uppercase tracking-[0.16em] ${
                            isAssistant ? "text-blue-600" : "text-blue-100"
                          }`}
                        >
                          {isAssistant ? "Headmaster" : "You"}
                        </span>
                        <span
                          className={`text-[10px] ${
                            isAssistant ? "text-slate-400" : "text-blue-100"
                          }`}
                        >
                          {formatMessageTime(message.createdAt)}
                        </span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
                        {message.content}
                      </p>
                      {message.usage?.total_tokens ? (
                        <p
                          className={`mt-2 text-[10px] ${
                            isAssistant ? "text-slate-400" : "text-blue-100"
                          }`}
                        >
                          {message.model || "model"} · {message.usage.total_tokens} tokens
                        </p>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
            {sending ? (
              <div className="flex justify-start">
                <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-500 shadow-sm">
                  <Loader2 size={12} className="animate-spin text-blue-500" />
                  Headmaster is responding
                </div>
              </div>
            ) : null}
          </div>

          <div className="border-t border-slate-200 bg-white px-4 py-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={
                  pending
                    ? "Check the pending request before continuing."
                    : runtimeReady
                      ? "Ask Headmaster to inspect the workspace, summarize logs, or draft a response..."
                      : "Wait for the Headmaster runtime to become ready before sending a prompt."
                }
                rows={4}
                disabled={!runtimeReady || blocked}
                className="w-full resize-none bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:text-slate-400"
              />
              <div className="mt-3 flex items-center justify-between gap-3">
                <div className="text-xs text-slate-500">
                  {sessionId ? `Session ${sessionId}` : "New Headmaster session"}
                </div>
                <button
                  onClick={handleSend}
                  disabled={!runtimeReady || blocked || !draft.trim()}
                  className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                  Send
                </button>
              </div>
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-3">
              <p className="text-sm font-bold text-slate-900">Session</p>
              <p className="mt-1 text-xs text-slate-500">
                Request context for the current chat thread.
              </p>
            </div>
            <div className="space-y-3 p-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                  Runtime
                </p>
                <p className="mt-1 text-sm font-bold text-slate-900">
                  {runtimeReady ? "Ready for chat" : "Unavailable"}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                  Model
                </p>
                <p className="mt-1 break-all text-sm font-medium text-slate-800">
                  {defaultModel || "Not reported"}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                  Session Id
                </p>
                <p className="mt-1 break-all text-sm font-medium text-slate-800">
                  {sessionId || "Created before sending"}
                </p>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-3">
              <p className="text-sm font-bold text-slate-900">Tips</p>
            </div>
            <div className="space-y-3 p-4 text-xs text-slate-600">
              <p>Use the Status tab first if Headmaster is still starting or models are missing.</p>
              <p>
                Integration and channel changes can restart Headmaster, so refresh this tab after
                edits.
              </p>
              <p>
                Conversation state is carried with the Headmaster session id until you reset it.
              </p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
