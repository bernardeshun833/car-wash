import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, queueTransaction } from "../lib/db";
import { getBranchId, getDeviceId } from "../lib/device";
import { newId } from "../lib/ids";
import { sync } from "../lib/sync";
import type { Attendant, PaymentMethod, WashService } from "../types";

type Step = "service" | "payment" | "done";

const PAYMENT_METHODS: { value: PaymentMethod; label: string; digital: boolean }[] = [
  { value: "cash", label: "Cash", digital: false },
  { value: "momo", label: "MoMo", digital: true },
  { value: "qr", label: "QR", digital: true },
  { value: "card", label: "Card", digital: true }
];

/**
 * Logging a wash.
 *
 * The attendant is whoever unlocked the app, so there is no "who washed it?"
 * step and no PIN to retype per car. On a cash-only site with one attendant
 * that reduces a wash to a single tap on the price — which is the point. The
 * slower the screen, the more likely a busy attendant logs nothing now and
 * reconstructs the day later from memory, and a day reconstructed from memory
 * is worth nothing to the reconciliation.
 *
 * The record keeps everything it kept before: attendant id, a verified unlock,
 * and the moment the wash was logged.
 */
export default function TransactionEntry({ attendant }: { attendant: Attendant }) {
  const services = useLiveQuery(() => db.services.toArray(), [], [] as WashService[]);
  const settings = useLiveQuery(() => db.settings.get("current"), []);

  // Cash only until the MoMo merchant account is live. Defaults to cash-only
  // when settings have not synced yet, so a fresh device cannot offer a
  // payment method the business cannot reconcile.
  const paymentMethods = PAYMENT_METHODS.filter(
    (m) => !m.digital || settings?.momo_enabled === true
  );
  const singleMethod = paymentMethods.length === 1 ? paymentMethods[0]! : null;

  const [step, setStep] = useState<Step>("service");
  const [service, setService] = useState<WashService | null>(null);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStep("service");
    setService(null);
    setMethod(null);
  };

  const record = async (chosenService: WashService, chosenMethod: PaymentMethod) => {
    setSaving(true);
    setError(null);

    // Anything that throws in here used to leave the screen completely
    // unchanged — the attendant taps a price, nothing happens, and the wash is
    // silently not recorded. On a POS that is the worst possible failure: it
    // looks like a dead button and reads, later, as a wash that never
    // happened. Whatever goes wrong now says so on screen.
    try {

      // Written to storage before anything touches the network. The wash is
      // durable the moment it is tapped, whatever the connection is doing.
      await queueTransaction({
        id: newId(),
        branch_id: getBranchId(),
        attendant_id: attendant.id,
        service_id: chosenService.id,
        amount: chosenService.price,
        payment_method: chosenMethod,
        corrects_transaction_id: null,
        created_at_local: new Date().toISOString(),
        device_id: getDeviceId()
      });

      setService(chosenService);
      setMethod(chosenMethod);
      setStep("done");
      void sync();
    } catch (e) {
      setError(
        `Could not save this wash: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setSaving(false);
    }
  };

  if (step === "done") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
        <div className="text-center">
          <p className="text-5xl">✓</p>
          <p className="mt-4 text-2xl font-semibold">Wash recorded</p>
          <p className="mt-2 text-gray-400">
            {service?.wash_type} · GHS {service?.price.toFixed(2)} · {method}
          </p>
        </div>
        <button type="button" className="btn-primary max-w-sm" onClick={reset}>
          Next vehicle
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4">
      {error && (
        <p className="rounded-xl bg-red-900/60 p-3 text-red-100">{error}</p>
      )}

      {step === "service" && services.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-lg font-medium">No price list on this phone yet</p>
          <p className="max-w-sm text-gray-400">
            It arrives on the first sync. Connect to the internet once and it
            will be saved here for good — after that the app works with no
            signal at all.
          </p>
        </div>
      )}

      {step === "service" && services.length > 0 && (
        <>
          <h1 className="text-xl font-semibold">Which wash?</h1>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {services.map((s) => (
              <button
                key={s.id}
                type="button"
                className="tile flex-col gap-1"
                disabled={saving}
                onClick={() => {
                  // One payment method means nothing to choose: record it
                  // straight away rather than making the attendant tap "Cash"
                  // on every car, which only teaches them to tap without
                  // reading.
                  if (singleMethod) {
                    void record(s, singleMethod.value);
                  } else {
                    setService(s);
                    setStep("payment");
                  }
                }}
              >
                <span>{s.wash_type}</span>
                <span className="text-sm text-gray-400">GHS {s.price.toFixed(2)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {step === "payment" && service && (
        <>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="btn-secondary px-4"
              onClick={() => setStep("service")}
            >
              ←
            </button>
            <div>
              <h1 className="text-xl font-semibold">How did they pay?</h1>
              <p className="text-sm text-gray-400">
                {service.wash_type} · GHS {service.price.toFixed(2)}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {paymentMethods.map((m) => (
              <button
                key={m.value}
                type="button"
                className="tile"
                disabled={saving}
                onClick={() => void record(service, m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
