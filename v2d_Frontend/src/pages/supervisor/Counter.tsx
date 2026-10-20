import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, CheckCircle2, CircleSlash, ScanLine, ShieldQuestion, Undo2, UserX } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { fmtTime, localToday, relativeDay } from "../../lib/format";
import type { SlotListItem } from "../../lib/types";
import { Button, ConfirmDialog, Empty, IntentBadge, Meter, PageHeader, QueryState, TextAreaField } from "../../components/ui";
import { WithMess } from "./common";

interface Verified {
  id: number;
  student: { userId: number; name: string; rollNumber: string };
  intent: "YES" | "NO" | "UNVOTED";
  walkIn: string;
  verifiedAt: string;
  counts: { verified: number; yes_voters: number; walk_ins: number };
}
type Result =
  | { tone: "ok"; title: string; detail: string; data: Verified }
  | { tone: "warn"; title: string; detail: string; pending: { input: string; isPass: boolean; intent: string; student: { name: string; rollNumber: string } } }
  | { tone: "danger"; title: string; detail: string };

interface AttendanceList {
  counts: { verified: number; yes_voters: number; walk_ins: number };
  items: { id: number; student: { name: string; rollNumber: string }; intent: string; walkIn: string; method: string; verifiedAt: string; verifiedBy: string; voided: boolean; note: string | null }[];
}

const isPass = (s: string) => s.trim().startsWith("V2D1.");

function useCameraScanner(onCode: (code: string) => void) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);
  const callback = useRef(onCode);
  callback.current = onCode;
  const supported = typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;
  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const detector = new (window as any).BarcodeDetector({ formats: ["qr_code"] });
        let last = "";
        const tick = async () => {
          if (stopped) return;
          try {
            const codes = await detector.detect(v);
            const raw = codes[0]?.rawValue;
            if (raw && raw !== last) {
              last = raw;
              callback.current(raw);
              setTimeout(() => (last = ""), 3000);
            }
          } catch {
            /* frame not ready */
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        setActive(false);
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [active]);
  return { videoRef, active, setActive, supported };
}

export default function Counter() {
  return <WithMess>{(messId) => <CounterBody messId={messId} />}</WithMess>;
}

function CounterBody({ messId }: { messId: number }) {
  const [params, setParams] = useSearchParams();
  const today = localToday();
  const slots = useQuery({
    queryKey: ["slots", messId, "counter", today],
    queryFn: () => api.get<SlotListItem[]>(`/messes/${messId}/slots?from=${localToday(-1)}&to=${today}`),
    refetchInterval: 30_000,
  });
  const candidates = (slots.data ?? []).filter((s) => s.status === "IN_SERVICE" || s.status === "SERVICE_CLOSED" || s.status === "APPROVED");
  const selectedId = Number(params.get("meal")) || candidates.find((s) => s.status === "IN_SERVICE")?.id || null;
  const slot = candidates.find((s) => s.id === selectedId) ?? (slots.data ?? []).find((s) => s.id === selectedId);

  return (
    <div className="page">
      <PageHeader title="Counter" subtitle="Verify who actually eats. Declarations, attendance and walk-in decisions are recorded separately." />
      <QueryState query={slots}>
        {() =>
          candidates.length === 0 && !slot ? (
            <Empty icon={<ScanLine size={22} aria-hidden="true" />} title="No meal is being served">
              The counter opens when a meal with an approved target starts service. <Link to="/supervisor">Back to today</Link>
            </Empty>
          ) : (
            <div className="stack" style={{ ["--gap" as string]: "20px" }}>
              <div className="segmented" role="radiogroup" aria-label="Meal at the counter">
                {candidates.map((s) => (
                  <label key={s.id}>
                    <input type="radio" name="meal" checked={s.id === selectedId} onChange={() => setParams({ meal: String(s.id) })} />
                    <span>
                      {s.mealType.name} · {relativeDay(s.serviceDate)}
                      {s.status !== "IN_SERVICE" && <span className="muted">({s.status === "APPROVED" ? "not started" : "closed"})</span>}
                    </span>
                  </label>
                ))}
              </div>
              {slot && <CounterDesk key={slot.id} slot={slot} />}
            </div>
          )
        }
      </QueryState>
    </div>
  );
}

function CounterDesk({ slot }: { slot: SlotListItem }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [walkInReason, setWalkInReason] = useState("");
  const [lateReason, setLateReason] = useState("");
  const [voiding, setVoiding] = useState<number | null>(null);
  const closed = slot.status === "SERVICE_CLOSED";
  const notStarted = slot.status === "APPROVED";

  const list = useQuery({ queryKey: ["attendance", slot.id], queryFn: () => api.get<AttendanceList>(`/slots/${slot.id}/attendance`), refetchInterval: 15_000 });

  const verify = useMutation({
    mutationFn: (body: Record<string, string>) => api.post<Verified>(`/slots/${slot.id}/attendance`, body),
  });

  const focus = () => setTimeout(() => inputRef.current?.focus(), 0);

  async function submit(raw: string, extra: Record<string, string> = {}) {
    const input = raw.trim();
    if (!input) return;
    const body: Record<string, string> = isPass(input) ? { passToken: input } : { rollNumber: input };
    if (closed) body.lateEntryReason = lateReason;
    try {
      const data = await verify.mutateAsync({ ...body, ...extra });
      setResult({
        tone: "ok",
        title: data.student.name,
        detail: data.walkIn === "NOT_WALK_IN" ? "Voted yes — welcome." : data.walkIn === "POLICY_PERMITTED" ? `${data.intent === "UNVOTED" ? "Didn't vote" : "Voted no"} — admitted under mess policy (recorded as a walk-in).` : "Admitted as an authorized walk-in.",
        data,
      });
      setWalkInReason("");
      qc.invalidateQueries({ queryKey: ["attendance", slot.id] });
      setValue("");
    } catch (err) {
      const e = err as ApiError;
      const d = (e.details ?? {}) as { student?: { name: string; rollNumber: string }; intent?: string; verifiedAt?: string; verifiedBy?: string };
      if (e.code === "WALK_IN_AUTHORIZATION_REQUIRED" && d.student) {
        setResult({ tone: "warn", title: d.student.name, detail: e.message, pending: { input, isPass: isPass(input), intent: d.intent ?? "UNVOTED", student: d.student } });
      } else if (e.code === "ALREADY_VERIFIED") {
        setResult({ tone: "danger", title: "Already served", detail: `${e.message}${d.verifiedAt ? ` at ${fmtTime(d.verifiedAt)}` : ""}${d.verifiedBy ? ` by ${d.verifiedBy}` : ""}.` });
        setValue("");
      } else {
        setResult({ tone: "danger", title: e.code === "STUDENT_NOT_FOUND" ? "Not found" : e.code === "NOT_ELIGIBLE" ? "Not eligible here" : "Not recorded", detail: e.message });
      }
    }
    focus();
  }

  const camera = useCameraScanner((code) => submit(code));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit(value);
  }

  const counts = list.data?.counts;
  const target = slot.summary.approvedServings;
  const toneIcon = result?.tone === "ok" ? <CheckCircle2 size={36} color="var(--ok)" /> : result?.tone === "warn" ? <ShieldQuestion size={36} color="var(--warn)" /> : <CircleSlash size={36} color="var(--danger)" />;

  return (
    <div className="split">
      <div className="stack" style={{ ["--gap" as string]: "16px" }}>
        <form onSubmit={onSubmit} className="panel panel-body stack" aria-label="Verify a student">
          <div className="row-between">
            <label htmlFor="counter-input" className="strong">
              Roll number or meal pass
            </label>
            <span className="text-sm muted mono">
              {slot.mealType.name} · {fmtTime(slot.serviceStartsAt)}–{fmtTime(slot.serviceEndsAt)}
            </span>
          </div>
          {notStarted && <div className="notice notice-warn">Service hasn't started. Start it from the meal page to open the counter.</div>}
          {closed && (
            <div className="stack" style={{ ["--gap" as string]: "8px" }}>
              <div className="notice notice-warn">Service has closed. Entries now are corrections and need a reason, which is audited.</div>
              <TextAreaField label="Reason for late entry" rows={2} value={lateReason} onChange={(e) => setLateReason(e.target.value)} placeholder="e.g. Counter tablet was offline; recorded from the paper register" />
            </div>
          )}
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input
              id="counter-input"
              ref={inputRef}
              className="input input-lg"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="e.g. 21CS0042"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              autoFocus
              disabled={notStarted}
              aria-describedby="counter-hint"
            />
            <Button type="submit" variant="primary" size="lg" busy={verify.isPending} disabled={notStarted || !value.trim() || (closed && lateReason.trim().length < 5)}>
              Verify
            </Button>
          </div>
          <div id="counter-hint" className="hint">
            Type a roll number and press Enter. Handheld scanners work here too.
            {camera.supported && (
              <>
                {" "}
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => camera.setActive(!camera.active)} style={{ minHeight: 0 }}>
                  <Camera size={14} aria-hidden="true" /> {camera.active ? "Stop camera" : "Scan with camera"}
                </button>
              </>
            )}
          </div>
          {camera.active && <video ref={camera.videoRef} muted playsInline style={{ width: "100%", maxHeight: 260, borderRadius: 4, background: "#000" }} aria-label="Camera preview for scanning meal passes" />}
        </form>

        <div aria-live="assertive" aria-atomic="true">
          {result && (
            <div className="counter-result" data-tone={result.tone}>
              {toneIcon}
              <div className="stack" style={{ ["--gap" as string]: "6px" }}>
                <div className="who">{result.title}</div>
                {"data" in result && (
                  <div className="row text-sm">
                    <span className="mono">{result.data.student.rollNumber}</span>
                    <IntentBadge intent={result.data.intent} />
                  </div>
                )}
                <div className="text-sm">{result.detail}</div>
                {result.tone === "warn" && "pending" in result && (
                  <form
                    className="stack"
                    style={{ ["--gap" as string]: "8px", marginTop: 6 }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      submit(result.pending.input, { walkInReason });
                    }}
                  >
                    <div className="row text-sm">
                      <span className="mono">{result.pending.student.rollNumber}</span>
                      <IntentBadge intent={result.pending.intent} />
                    </div>
                    <TextAreaField label="Reason for admitting" rows={2} value={walkInReason} onChange={(e) => setWalkInReason(e.target.value)} placeholder="e.g. Plans changed — exam rescheduled" autoFocus />
                    <div className="row">
                      <Button type="submit" variant="primary" busy={verify.isPending} disabled={walkInReason.trim().length < 5}>
                        Admit as walk-in
                      </Button>
                      <Button
                        icon={<UserX size={15} />}
                        onClick={() => {
                          setResult(null);
                          setValue("");
                          focus();
                        }}
                      >
                        Don't admit
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="stack" style={{ ["--gap" as string]: "16px" }}>
        <section className="panel panel-body stack" style={{ ["--gap" as string]: "10px" }}>
          <div className="row-between">
            <span className="text-sm muted">Served</span>
            <span className="big-number num" style={{ fontSize: "2.25rem" }}>
              {counts?.verified ?? "…"}
              {target !== null && <span className="text-md muted" style={{ fontSize: "1rem", fontWeight: 500 }}> / {target}</span>}
            </span>
          </div>
          {target !== null && counts && <Meter value={counts.verified} max={target} label="Served against approved target" />}
          {counts && (
            <div className="text-sm muted num">
              {counts.yes_voters} yes voters · {counts.walk_ins} walk-ins
            </div>
          )}
        </section>
        <section className="panel">
          <div className="panel-head">
            <h3>Recent</h3>
          </div>
          {list.data?.items.length ? (
            <ul className="ruled" style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 420, overflow: "auto" }}>
              {list.data.items.slice(0, 40).map((a) => (
                <li key={a.id} className="row" style={{ padding: "8px 16px", flexWrap: "nowrap", opacity: a.voided ? 0.5 : 1 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="text-sm strong" style={{ textDecoration: a.voided ? "line-through" : undefined }}>
                      {a.student.name}
                    </span>
                    <span className="text-xs muted mono" style={{ display: "block" }}>
                      {a.student.rollNumber} · {fmtTime(a.verifiedAt)} {a.walkIn !== "NOT_WALK_IN" && "· walk-in"}
                    </span>
                  </span>
                  <IntentBadge intent={a.intent} />
                  {!a.voided && (slot.status === "IN_SERVICE" || slot.status === "SERVICE_CLOSED") && (
                    <button className="icon-btn" onClick={() => setVoiding(a.id)} aria-label={`Undo verification of ${a.student.name}`} title="Undo (recorded mistake)">
                      <Undo2 size={15} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="panel-body text-sm muted">No one verified yet.</div>
          )}
        </section>
      </div>
      <ConfirmDialog
        open={voiding !== null}
        onClose={() => setVoiding(null)}
        title="Undo this verification?"
        body={<p className="text-sm">The record is kept but marked void, with your reason, in the audit trail.</p>}
        confirmLabel="Undo verification"
        tone="danger"
        requireReason
        onConfirm={async (reason) => {
          await api.post(`/attendance/${voiding}/void`, { reason });
          qc.invalidateQueries({ queryKey: ["attendance", slot.id] });
        }}
      />
    </div>
  );
}
