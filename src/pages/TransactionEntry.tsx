import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import NumPad from "../components/NumPad";
import { db, queueTransaction } from "../lib/db";
import { getBranchId, getDeviceId } from "../lib/device";
import { verifyPin } from "../lib/pin";
import { sync } from "../lib/sync";
import type { Attendant, PaymentMethod, WashService } from "../types";

type Step = "attendant" | "service" | "payment" | "pin" | "done";

const PAYMENT_METHODS: { value: PaymentMethod; label: string; digital: boolean }[] = [
  { value: "cash", label: "Cash", digital: false },
  { value: "momo", label: "MoMo", digital: true },
  { value: "qr", label: "QR", digital: true },
  { value: "card", label: "Card", digital: true }
];

/**
 * PIN per transaction, kept from the barbershop and kept deliberately.
 *
 * How many attendants the wash actually has is still unconfirmed, and the
 * answer does not change this screen. Even if it turns out one person works
 * every shift — making attribution moot — the PIN step is what stamps an
 * entry with a verified moment in time, and those timestamps are what the
 * reconciliation windows are built on. It is cheap to keep and expensive to
 * add back later.
 */
export default function TransactionEntry() {
  const attendants = useLiveQuery(() => db.attendants.toArray(), [], [] as Attendant[]);
  const services = useLiveQuery(() => db.services.toArray(), [], [] as WashService[]);
  const settings = useLiveQuery(() => db.settings.get("current"), []);

  // Cash only until the MoMo merchant account is live. The digital tiles are
  // hidden rather than removed: turning them on is a database flag and the
  // next sync, with no new build. Defaults to cash-only when settings have
  // not synced yet, so a fresh tablet cannot offer a payment method the
  // business cannot actually reconcile.
  const paymentMethods = PAYMENT_METHODS.filter(
    (m) => !m.digital || settings?.momo_enabled === true
  );

  const [step, setStep] = useState<Step>("attendant");
  const [attendant, setAttendant] = useState<Attendant | null>(null);
  const [service, setService] = useState<WashService | null>(null);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const reset = () => {
    setStep("attendant");
    setAttendant(null);
    setService(null);
    setMethod(null);
    setPin("");
    setError(null);
  };

  const confirm = async () => {
    if (!attendant || !service || !method) return;
    setChecking(true);
    setError(null);

    const ok = await verifyPin(pin, attendant);
    if (!ok) {
      setChecking(false);
      setPin("");
      setError(`That is not ${attendant.name.split(" ")[0]}'s PIN`);
      return;
    }

    // Written to IndexedDB before anything touches the network. The wash is
    // durable the moment the PIN is accepted, whatever the connection is
    // doing.
    await queueTransaction({
      id: crypto.randomUUID(),
      branch_id: getBranchId(),
      attendant_id: attendant.id,
      service_id: service.id,
      amount: service.price,
      payment_method: method,
      corrects_transaction_id: null,
      created_at_local: new Date().toISOString(),
      device_id: getDeviceId()
    });

    setChecking(false);
    setStep("done");
    void sync();
  };

  if (step === "done") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
        <div className="text-center">
          <p className="text-5xl">✓</p>
          <p className="mt-4 text-2xl font-semibold">Wash recorded</p>
          <p className="mt-2 text-gray-400">
            {service?.wash_type} · GHS {service?.price.toFixed(2)} · {method} ·{" "}
            {attendant?.name}
          </p>
        </div>
        <button type="button" className="btn-primary max-w-sm" onClick={reset}>
          Next vehicle
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <StepHeader
        step={step}
        attendant={attendant}
        service={service}
        method={method}
        onBack={() => {
          setError(null);
          if (step === "service") setStep("attendant");
          if (step === "payment") setStep("service");
          if (step === "pin") {
            setPin("");
            // Skip the payment step on the way back too, when it was skipped
            // on the way in.
            setStep(paymentMethods.length === 1 ? "service" : "payment");
          }
        }}
      />

      {step === "attendant" && (
        <Grid>
          {attendants.map((a) => (
            <button
              key={a.id}
              type="button"
              className="tile"
              onClick={() => {
                setAttendant(a);
                setStep("service");
              }}
            >
              {a.name}
            </button>
          ))}
        </Grid>
      )}

      {step === "service" && (
        <Grid>
          {services.map((s) => (
            <button
              key={s.id}
              type="button"
              className="tile flex-col gap-1"
              onClick={() => {
                setService(s);
                // With only one payment method there is nothing to choose;
                // making the attendant tap "Cash" every time is a tap that
                // teaches them to tap without reading.
                if (paymentMethods.length === 1) {
                  setMethod(paymentMethods[0].value);
                  setStep("pin");
                } else {
                  setStep("payment");
                }
              }}
            >
              <span>{s.wash_type}</span>
              <span className="text-sm text-gray-400">GHS {s.price.toFixed(2)}</span>
            </button>
          ))}
        </Grid>
      )}

      {step === "payment" && (
        <Grid>
          {paymentMethods.map((m) => (
            <button
              key={m.value}
              type="button"
              className="tile"
              onClick={() => {
                setMethod(m.value);
                setStep("pin");
              }}
            >
              {m.label}
            </button>
          ))}
        </Grid>
      )}

      {step === "pin" && attendant && (
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-4">
          <p className="text-center text-lg">{attendant.name}, enter your PIN to confirm</p>
          <div className="flex justify-center gap-3">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={`h-4 w-4 rounded-full ${
                  i < pin.length ? "bg-emerald-400" : "bg-gray-700"
                }`}
              />
            ))}
          </div>
          {error && <p className="text-center text-amber-300">{error}</p>}
          <NumPad value={pin} onChange={setPin} />
          <button
            type="button"
            className="btn-primary"
            disabled={pin.length !== 4 || checking}
            onClick={confirm}
          >
            {checking ? "Checking…" : `Confirm GHS ${service?.price.toFixed(2)}`}
          </button>
        </div>
      )}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{children}</div>;
}

function StepHeader({
  step,
  attendant,
  service,
  method,
  onBack
}: {
  step: Step;
  attendant: Attendant | null;
  service: WashService | null;
  method: PaymentMethod | null;
  onBack: () => void;
}) {
  const titles: Record<Exclude<Step, "done">, string> = {
    attendant: "Who washed it?",
    service: "Which wash?",
    payment: "How did they pay?",
    pin: "Confirm with PIN"
  };

  return (
    <div className="flex items-center gap-3">
      {step !== "attendant" && (
        <button type="button" className="btn-secondary px-4" onClick={onBack}>
          ←
        </button>
      )}
      <div>
        <h1 className="text-xl font-semibold">{titles[step as Exclude<Step, "done">]}</h1>
        <p className="text-sm text-gray-400">
          {[attendant?.name, service?.wash_type, method].filter(Boolean).join(" · ") ||
            "New wash"}
        </p>
      </div>
    </div>
  );
}
